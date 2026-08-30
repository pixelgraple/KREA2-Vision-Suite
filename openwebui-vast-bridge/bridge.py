"""Loopback OpenAI-compatible bridge for a private Vast Serverless model."""

from __future__ import annotations

import asyncio
import hmac
import json
import math
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

import requests
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
    required = ("model", "bridge_api_key")
    for key in required:
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise RuntimeError(f"Bridge config field is missing: {key}")
    upstream_base_url = str(data.get("upstream_base_url") or "").strip()
    if upstream_base_url:
        if len(str(data.get("upstream_api_key") or "")) < 24:
            raise RuntimeError("Dedicated upstream credential is invalid.")
    elif (
        len(str(data.get("vast_api_key") or "")) < 24
        or not str(data.get("endpoint") or "").strip()
    ):
        raise RuntimeError("Vast Serverless bridge configuration is invalid.")
    if len(data["bridge_api_key"]) < 24:
        raise RuntimeError("Bridge credentials are invalid.")
    return data


CONFIG = _load_config()
ENDPOINT = str(CONFIG.get("endpoint") or "").strip()
MODEL = CONFIG["model"].strip()
VAST_API_KEY = str(CONFIG.get("vast_api_key") or "").strip()
BRIDGE_API_KEY = CONFIG["bridge_api_key"].strip()
UPSTREAM_BASE_URL = str(CONFIG.get("upstream_base_url") or "").strip().rstrip("/")
UPSTREAM_API_KEY = str(CONFIG.get("upstream_api_key") or "").strip()
REQUEST_TIMEOUT = float(CONFIG.get("request_timeout", 240))
SSE_KEEPALIVE_SECONDS = max(
    1.0,
    min(30.0, float(CONFIG.get("stream_keepalive_seconds", 10))),
)
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
CONTEXT_TARGET_INPUT_TOKENS = max(
    2048,
    min(MODEL_CONTEXT_TOKENS - 1024, int(CONFIG.get("context_target_input_tokens", 12288))),
)
CONTEXT_TEMPLATE_RESERVE_TOKENS = max(
    256,
    int(CONFIG.get("context_template_reserve_tokens", 1024)),
)
CONTEXT_SUMMARY_MAX_CHARS = max(
    256,
    int(CONFIG.get("context_summary_max_chars", 1800)),
)
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


def _estimate_text_tokens(value: Any) -> int:
    """Conservative tokenizer-free estimate for mixed prose, code, and Unicode."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if not text:
        return 0
    utf8_bytes = len(text.encode("utf-8"))
    return max(math.ceil(len(text) / 3), math.ceil(utf8_bytes / 3))


def _estimate_message_tokens(message: dict[str, Any]) -> int:
    return 8 + _estimate_text_tokens(message)


def _clip_text(value: str, token_budget: int) -> str:
    text = str(value or "")
    if _estimate_text_tokens(text) <= token_budget:
        return text
    if token_budget <= 32:
        return text[-max(16, token_budget * 2):]
    char_budget = max(96, token_budget * 2)
    head_chars = max(48, char_budget // 3)
    tail_chars = max(48, char_budget - head_chars)
    marker = "\n\n[...older text compacted locally to fit the 32K cloud context...]\n\n"
    clipped = f"{text[:head_chars]}{marker}{text[-tail_chars:]}"
    while _estimate_text_tokens(clipped) > token_budget and tail_chars > 48:
        tail_chars = max(48, int(tail_chars * 0.85))
        head_chars = max(48, int(head_chars * 0.85))
        clipped = f"{text[:head_chars]}{marker}{text[-tail_chars:]}"
    return clipped


def _clip_message(message: dict[str, Any], token_budget: int) -> dict[str, Any]:
    clipped = dict(message)
    content = clipped.get("content")
    if isinstance(content, str):
        clipped["content"] = _clip_text(content, max(32, token_budget - 12))
    else:
        serialized = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
        clipped["content"] = _clip_text(serialized, max(32, token_budget - 12))
    return clipped


def _message_content_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"].strip())
            elif isinstance(item, str):
                parts.append(item.strip())
        return "\n".join(part for part in parts if part)
    if content is None:
        return ""
    return json.dumps(content, ensure_ascii=False, separators=(",", ":"))


def _normalize_system_messages(messages: list[Any]) -> list[dict[str, Any]]:
    """Make saved Open WebUI chats valid for strict Qwen templates.

    Open WebUI can inject a new system/developer record after earlier user and
    assistant turns. The dedicated Qwen template permits exactly one system
    instruction block and requires it to be the first message. Preserve every
    instruction, but merge them into that single leading block for only this
    outbound request; the stored Open WebUI transcript remains unchanged.
    """

    instructions: list[str] = []
    conversation: list[dict[str, Any]] = []
    for raw_message in messages:
        if not isinstance(raw_message, dict):
            continue
        message = dict(raw_message)
        role = str(message.get("role") or "").lower()
        if role in {"system", "developer"}:
            text = _message_content_text(message)
            if text:
                instructions.append(text)
            continue
        conversation.append(message)
    if not instructions:
        return conversation
    return [
        {"role": "system", "content": "\n\n".join(instructions)},
        *conversation,
    ]


def _compact_messages(
    messages: list[Any],
    input_token_budget: int,
) -> tuple[list[dict[str, Any]], dict[str, int | bool]]:
    original = [dict(message) for message in messages if isinstance(message, dict)]
    normalized = _normalize_system_messages(original)
    before_tokens = sum(_estimate_message_tokens(message) for message in original)
    normalized_tokens = sum(_estimate_message_tokens(message) for message in normalized)
    if normalized_tokens <= input_token_budget:
        return normalized, {
            "compacted": False,
            "before_tokens": before_tokens,
            "after_tokens": normalized_tokens,
            "omitted_messages": 0,
        }

    system_messages: list[dict[str, Any]] = []
    conversation: list[dict[str, Any]] = []
    for message in normalized:
        if str(message.get("role") or "").lower() in {"system", "developer"} and not conversation:
            system_messages.append(message)
        else:
            conversation.append(message)

    # Keep the first instruction block, the newest turns, and a short local digest.
    # Open WebUI remains the source of truth for the complete raw transcript.
    system_budget = min(max(1024, input_token_budget // 4), 4096)
    retained_system: list[dict[str, Any]] = []
    used = 0
    for message in system_messages:
        remaining = system_budget - used
        if remaining < 64:
            break
        clipped = _clip_message(message, remaining)
        retained_system.append(clipped)
        used += _estimate_message_tokens(clipped)

    recent_budget = max(512, input_token_budget - used - 768)
    recent_reversed: list[dict[str, Any]] = []
    recent_used = 0
    omitted_count = 0
    for message in reversed(conversation):
        tokens = _estimate_message_tokens(message)
        remaining = recent_budget - recent_used
        if remaining >= tokens:
            recent_reversed.append(message)
            recent_used += tokens
            continue
        if not recent_reversed and remaining >= 64:
            clipped = _clip_message(message, remaining)
            recent_reversed.append(clipped)
            recent_used += _estimate_message_tokens(clipped)
        omitted_count += 1
    recent = list(reversed(recent_reversed))
    omitted = conversation[:max(0, len(conversation) - len(recent_reversed))]

    digest_parts: list[str] = []
    digest_chars = 0
    for message in omitted[-12:]:
        role = str(message.get("role") or "message").lower()
        content = message.get("content")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        text = " ".join(text.split())
        if not text:
            continue
        excerpt = text[:220]
        part = f"{role}: {excerpt}"
        if digest_chars + len(part) > CONTEXT_SUMMARY_MAX_CHARS:
            break
        digest_parts.append(part)
        digest_chars += len(part)
    digest_text = ""
    if digest_parts:
        digest_text = (
            "[Local 32K context compaction: older raw turns were removed only from this outbound "
            "model request; the complete conversation remains in Open WebUI history. Recent older "
            "turn excerpts follow.]\n" + "\n".join(digest_parts)
        )

    compacted = [*retained_system]
    if digest_text:
        if compacted and compacted[0].get("role") == "system":
            compacted[0] = {
                "role": "system",
                "content": f"{_message_content_text(compacted[0])}\n\n{digest_text}".strip(),
            }
        else:
            compacted.insert(0, {"role": "system", "content": digest_text})
    compacted.extend(recent)
    while compacted and sum(_estimate_message_tokens(item) for item in compacted) > input_token_budget:
        removable = next(
            (index for index, item in enumerate(compacted[:-1]) if item.get("role") != "system"),
            None,
        )
        if removable is None:
            if len(compacted) == 1:
                compacted[0] = _clip_message(compacted[0], input_token_budget)
                break
            compacted.pop(1 if len(compacted) > 1 else 0)
        else:
            compacted.pop(removable)

    after_tokens = sum(_estimate_message_tokens(message) for message in compacted)
    return compacted, {
        "compacted": True,
        "before_tokens": before_tokens,
        "after_tokens": after_tokens,
        "omitted_messages": max(omitted_count, len(normalized) - len(compacted)),
    }


def _clean_payload(body: Any) -> tuple[dict[str, Any], int, bool, dict[str, int | bool]]:
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
    non_message_payload = {key: value for key, value in payload.items() if key != "messages"}
    overhead_tokens = _estimate_text_tokens(non_message_payload) + CONTEXT_TEMPLATE_RESERVE_TOKENS
    input_budget = min(
        CONTEXT_TARGET_INPUT_TOKENS,
        max(512, MODEL_CONTEXT_TOKENS - max_tokens - overhead_tokens),
    )
    compacted_messages, context_info = _compact_messages(messages, input_budget)
    payload["messages"] = compacted_messages
    context_info["input_budget"] = input_budget
    context_info["output_budget"] = max_tokens
    return payload, max_tokens, stream, context_info


async def _request_vast(payload: dict[str, Any], cost: int, *, stream: bool) -> Any:
    # One private llama.cpp worker is intentionally configured for one request
    # at a time. Queue overlapping Open WebUI/sub-agent calls locally so Vast
    # never rejects a parallel burst while the single GPU is busy.
    async with VAST_REQUEST_GATE:
        if UPSTREAM_BASE_URL:
            def request_dedicated() -> dict[str, Any]:
                response = requests.post(
                    f"{UPSTREAM_BASE_URL}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {UPSTREAM_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={**payload, "stream": False},
                    timeout=REQUEST_TIMEOUT,
                )
                try:
                    document = response.json()
                except Exception as exc:
                    raise RuntimeError(
                        f"KREA2 gateway returned a non-JSON error (HTTP {response.status_code})"
                    ) from exc
                if response.status_code >= 400:
                    detail = document.get("detail") if isinstance(document, dict) else None
                    raise RuntimeError(
                        f"Dedicated Qwen failed (HTTP {response.status_code}): {str(detail or 'unknown error')[:300]}"
                    )
                if not isinstance(document, dict):
                    raise RuntimeError("Dedicated Qwen returned a non-object response")
                return {"ok": True, "response": document}

            return await asyncio.to_thread(request_dedicated)
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
        if UPSTREAM_BASE_URL:
            result = await _request_vast(payload, cost, stream=False)
            document = _unwrap_response(result)
            choices = document.get("choices") or []
            message = choices[0].get("message") if choices and isinstance(choices[0], dict) else {}
            content = str((message or {}).get("content") or "")
            completion_id = str(document.get("id") or f"chatcmpl-{uuid.uuid4().hex}")
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": MODEL,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": content},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")
            chunk["choices"][0]["delta"] = {}
            chunk["choices"][0]["finish_reason"] = "stop"
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")
            yield b"data: [DONE]\n\n"
            return
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
                    # Vast can spend several minutes activating a cold worker.
                    # Await the SDK request in a task and emit legal SSE comments
                    # while it is pending. Open WebUI ignores the comments, but
                    # they keep the local response alive instead of presenting a
                    # misleading dead connection while the worker is warming.
                    request_task = asyncio.create_task(
                        endpoint.request(
                            "/v1/chat/completions",
                            segment_payload,
                            cost=int(segment_payload.get("max_tokens") or cost),
                            timeout=REQUEST_TIMEOUT,
                            retry=True,
                            stream=True,
                        )
                    )
                    try:
                        while True:
                            try:
                                result = await asyncio.wait_for(
                                    asyncio.shield(request_task),
                                    timeout=SSE_KEEPALIVE_SECONDS,
                                )
                                break
                            except TimeoutError:
                                yield b": krea2-worker-warming\n\n"
                    finally:
                        if not request_task.done():
                            request_task.cancel()
                            try:
                                await request_task
                            except (asyncio.CancelledError, Exception):
                                pass
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
    return {
        "ok": True,
        "endpoint": ENDPOINT,
        "runtime": "dedicated" if UPSTREAM_BASE_URL else "serverless",
        "model": MODEL,
        "model_context_tokens": MODEL_CONTEXT_TOKENS,
        "target_input_tokens": CONTEXT_TARGET_INPUT_TOKENS,
    }


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
    payload, cost, stream, context_info = _clean_payload(body)
    context_headers = {
        "X-Krea2-Context-Compacted": "true" if context_info["compacted"] else "false",
        "X-Krea2-Context-Tokens": str(context_info["after_tokens"]),
        "X-Krea2-Context-Budget": str(context_info["input_budget"]),
    }
    if stream:
        return StreamingResponse(
            _sse_stream(payload, cost),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                **context_headers,
            },
        )
    try:
        result = await _request_vast(payload, cost, stream=False)
        return JSONResponse(_unwrap_response(result), headers=context_headers)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc
