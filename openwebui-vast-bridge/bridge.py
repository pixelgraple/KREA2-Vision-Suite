"""Loopback OpenAI-compatible bridge for a private Vast Serverless model."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from vastai import CoroutineServerless


CONFIG_PATH = Path(
    os.environ.get(
        "VAST_OPENWEBUI_BRIDGE_CONFIG",
        str(Path(__file__).with_name("config.json")),
    )
)


def _load_config() -> dict[str, Any]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Bridge config could not be read: {CONFIG_PATH}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Bridge config must be a JSON object.")
    required = ("vast_api_key", "endpoint", "model", "bridge_api_key")
    for key in required:
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise RuntimeError(f"Bridge config field is missing: {key}")
    if len(data["vast_api_key"]) < 24 or len(data["bridge_api_key"]) < 24:
        raise RuntimeError("Bridge credentials are invalid.")
    return data


CONFIG = _load_config()
ENDPOINT = CONFIG["endpoint"].strip()
MODEL = CONFIG["model"].strip()
VAST_API_KEY = CONFIG["vast_api_key"].strip()
BRIDGE_API_KEY = CONFIG["bridge_api_key"].strip()
REQUEST_TIMEOUT = float(CONFIG.get("request_timeout", 240))
MAX_TOKENS_LIMIT = int(CONFIG.get("max_tokens_limit", 16384))
DEFAULT_MAX_TOKENS = max(
    1,
    min(MAX_TOKENS_LIMIT, int(CONFIG.get("default_max_tokens", 8192))),
)
AUTO_CONTINUE_MAX_SEGMENTS = max(
    1,
    min(4, int(CONFIG.get("auto_continue_max_segments", 3))),
)
MODEL_CONTEXT_TOKENS = max(4096, int(CONFIG.get("model_context_tokens", 32768)))
MAX_PARALLEL_REQUESTS = max(1, min(8, int(CONFIG.get("max_parallel_requests", 1))))
VAST_REQUEST_GATE = asyncio.Semaphore(MAX_PARALLEL_REQUESTS)

app = FastAPI(
    title="Local Vast OpenAI Bridge",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def _authorize(authorization: str | None) -> None:
    supplied = ""
    if isinstance(authorization, str) and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not hmac.compare_digest(supplied, BRIDGE_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid bridge API key")


def _model_record() -> dict[str, Any]:
    return {
        "id": MODEL,
        "object": "model",
        "created": 0,
        "owned_by": "vast-serverless-local",
    }


def _unwrap_response(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise RuntimeError("Vast returned a non-object response.")
    if result.get("ok") is False:
        status = result.get("status")
        nested_error = result.get("response")
        if isinstance(nested_error, dict):
            nested_error = nested_error.get("error") or nested_error.get("detail")
        detail = nested_error or result.get("error") or result.get("text")
        suffix = f" (HTTP {status})" if status else ""
        if detail:
            raise RuntimeError(f"Vast request failed{suffix}: {str(detail)[:300]}")
        raise RuntimeError(f"Vast request failed{suffix}.")
    nested = result.get("response")
    if isinstance(nested, str):
        nested = json.loads(nested)
    if isinstance(nested, dict):
        return nested
    return result


def _clean_payload(body: Any) -> tuple[dict[str, Any], int, bool]:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    payload = dict(body)
    payload["model"] = MODEL
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages must be a non-empty array")

    try:
        max_tokens = int(
            payload.get("max_tokens")
            or payload.get("max_completion_tokens")
            or DEFAULT_MAX_TOKENS
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="max_tokens must be an integer") from exc
    max_tokens = max(1, min(MAX_TOKENS_LIMIT, max_tokens))
    payload["max_tokens"] = max_tokens
    payload.pop("max_completion_tokens", None)

    # Open WebUI adds bookkeeping fields that llama.cpp does not use.
    for key in ("chat_id", "id", "session_id", "metadata"):
        payload.pop(key, None)
    template_kwargs = payload.get("chat_template_kwargs")
    if not isinstance(template_kwargs, dict):
        template_kwargs = {}
    template_kwargs.setdefault("enable_thinking", False)
    payload["chat_template_kwargs"] = template_kwargs
    stream = bool(payload.get("stream", False))
    payload["stream"] = stream
    return payload, max_tokens, stream


async def _request_vast(payload: dict[str, Any], cost: int, *, stream: bool) -> Any:
    # One private llama.cpp worker is intentionally configured for one request
    # at a time. Queue overlapping Open WebUI/sub-agent calls locally so Vast
    # never rejects a parallel burst while the single GPU is busy.
    async with VAST_REQUEST_GATE:
        async with CoroutineServerless(
            api_key=VAST_API_KEY,
            default_request_timeout=REQUEST_TIMEOUT,
        ) as client:
            endpoint = await client.get_endpoint(ENDPOINT)
            return await endpoint.request(
                "/v1/chat/completions",
                payload,
                cost=cost,
                timeout=REQUEST_TIMEOUT,
                retry=True,
                stream=stream,
            )


def _stream_source(result: Any) -> Any:
    if not isinstance(result, dict):
        raise RuntimeError("Vast returned a non-object stream wrapper.")
    source = result.get("response")
    if source is None:
        source = result
    return source


def _stream_event_content(event: dict[str, Any]) -> str:
    choices = event.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return ""
    choice = choices[0]
    delta = choice.get("delta") or {}
    message = choice.get("message") or {}
    return str(delta.get("content") or message.get("content") or "")


def _stream_finish_reason(event: dict[str, Any]) -> str | None:
    choices = event.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return None
    reason = choices[0].get("finish_reason")
    return str(reason) if reason is not None else None


def _needs_code_continuation(content: str, finish_reason: str | None) -> bool:
    if finish_reason == "length":
        return True
    # A natural stop in the middle of a fenced code block is an unreliable EOS,
    # not a complete coding answer. Continue without requiring a second click.
    return content.count("```") % 2 == 1


def _continuation_payload(payload: dict[str, Any], content: str) -> dict[str, Any]:
    continued = dict(payload)
    continued["messages"] = [
        *payload["messages"],
        {"role": "assistant", "content": content},
        {
            "role": "user",
            "content": (
                "Continue exactly where the preceding response stopped. "
                "Do not repeat earlier text. Finish the open code block and the requested file. "
                "Output only the continuation."
            ),
        },
    ]
    return continued


def _usage_total_tokens(usage: Any) -> int | None:
    if not isinstance(usage, dict):
        return None
    total = usage.get("total_tokens")
    if total is None:
        prompt = usage.get("prompt_tokens") or usage.get("input_tokens")
        output = usage.get("completion_tokens") or usage.get("output_tokens")
        if prompt is not None and output is not None:
            total = int(prompt) + int(output)
    try:
        return int(total) if total is not None else None
    except (TypeError, ValueError):
        return None


def _continuation_token_budget(payload: dict[str, Any], usage_total: int | None) -> int:
    if usage_total is None:
        # Fallback only; llama.cpp normally returns exact usage in the terminal
        # event. Reserve extra room for templates and tool schemas.
        message_chars = len(json.dumps(payload.get("messages") or [], ensure_ascii=False))
        usage_total = message_chars // 4 + 2048
    return max(0, MODEL_CONTEXT_TOKENS - usage_total - 512)


async def _sse_stream(payload: dict[str, Any], cost: int) -> AsyncIterator[bytes]:
    try:
        # Keep the SDK client alive until the remote async iterator is exhausted.
        # Closing it immediately after endpoint.request() can terminate a valid
        # Open WebUI stream before any generated tokens reach the browser.
        async with VAST_REQUEST_GATE:
            async with CoroutineServerless(
                api_key=VAST_API_KEY,
                default_request_timeout=REQUEST_TIMEOUT,
            ) as client:
                endpoint = await client.get_endpoint(ENDPOINT)
                segment_payload = payload
                generated_content = ""
                for segment_index in range(AUTO_CONTINUE_MAX_SEGMENTS):
                    result = await endpoint.request(
                        "/v1/chat/completions",
                        segment_payload,
                        cost=int(segment_payload.get("max_tokens") or cost),
                        timeout=REQUEST_TIMEOUT,
                        retry=True,
                        stream=True,
                    )
                    source = _stream_source(result)
                    finish_reason = None
                    terminal_event = None
                    usage_total = None
                    if hasattr(source, "__aiter__"):
                        async for event in source:
                            if isinstance(event, bytes):
                                text = event.decode("utf-8", errors="replace").strip()
                                if text.startswith("data:"):
                                    text = text[5:].strip()
                                if text == "[DONE]":
                                    break
                                try:
                                    event = json.loads(text)
                                except json.JSONDecodeError:
                                    continue
                            if isinstance(event, str):
                                text = event.strip()
                                if text.startswith("data:"):
                                    text = text[5:].strip()
                                if text == "[DONE]":
                                    break
                                try:
                                    event = json.loads(text)
                                except json.JSONDecodeError:
                                    continue
                            if not isinstance(event, dict):
                                continue
                            content = _stream_event_content(event)
                            if content:
                                generated_content += content
                            event_finish_reason = _stream_finish_reason(event)
                            event_usage_total = _usage_total_tokens(event.get("usage"))
                            if event_usage_total is not None:
                                usage_total = event_usage_total
                            if event_finish_reason is not None:
                                finish_reason = event_finish_reason
                                terminal_event = event
                                continue
                            # Intermediate usage-only chunks would make Open WebUI
                            # think the first segment is the final response.
                            if not content and event.get("usage"):
                                terminal_event = event
                                continue
                            yield f"data: {json.dumps(event, separators=(',', ':'))}\n\n".encode("utf-8")
                    else:
                        data = _unwrap_response(result)
                        choice = (data.get("choices") or [{}])[0]
                        content = str((choice.get("message") or {}).get("content") or "")
                        generated_content += content
                        finish_reason = choice.get("finish_reason")
                        terminal_event = {
                            "id": data.get("id") or f"chatcmpl-{uuid.uuid4().hex}",
                            "object": "chat.completion.chunk",
                            "created": data.get("created") or int(time.time()),
                            "model": MODEL,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"content": content},
                                    "finish_reason": finish_reason,
                                }
                            ],
                            "usage": data.get("usage"),
                        }
                        usage_total = _usage_total_tokens(data.get("usage"))
                        if content:
                            visible_event = dict(terminal_event)
                            visible_event["choices"] = [
                                {"index": 0, "delta": {"content": content}, "finish_reason": None}
                            ]
                            yield f"data: {json.dumps(visible_event, separators=(',', ':'))}\n\n".encode("utf-8")

                    continuation_budget = _continuation_token_budget(segment_payload, usage_total)
                    if (
                        segment_index + 1 < AUTO_CONTINUE_MAX_SEGMENTS
                        and _needs_code_continuation(generated_content, finish_reason)
                        and continuation_budget >= 256
                    ):
                        segment_payload = _continuation_payload(payload, generated_content)
                        segment_payload["max_tokens"] = min(
                            int(payload.get("max_tokens") or DEFAULT_MAX_TOKENS),
                            continuation_budget,
                        )
                        continue

                    if terminal_event is None:
                        terminal_event = {
                            "id": f"chatcmpl-{uuid.uuid4().hex}",
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": MODEL,
                            "choices": [
                                {"index": 0, "delta": {}, "finish_reason": finish_reason or "stop"}
                            ],
                        }
                    yield f"data: {json.dumps(terminal_event, separators=(',', ':'))}\n\n".encode("utf-8")
                    break
        # Close the Vast SDK context before exposing the terminal marker to the
        # browser. This releases remote worker load even if the browser closes
        # its response immediately after seeing [DONE].
        yield b"data: [DONE]\n\n"
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        error = {"error": {"message": str(exc)[:500], "type": "vast_serverless_error"}}
        yield f"data: {json.dumps(error, separators=(',', ':'))}\n\n".encode("utf-8")
        yield b"data: [DONE]\n\n"


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "endpoint": ENDPOINT, "model": MODEL}


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(authorization)
    return {"object": "list", "data": [_model_record()]}


@app.post("/v1/chat/completions", response_model=None)
async def chat_completions(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse | StreamingResponse:
    _authorize(authorization)
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON request") from exc
    payload, cost, stream = _clean_payload(body)
    if stream:
        return StreamingResponse(
            _sse_stream(payload, cost),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    try:
        result = await _request_vast(payload, cost, stream=False)
        return JSONResponse(_unwrap_response(result))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc
