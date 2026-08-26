"""Isolated Vast Serverless SDK bridge.

This file runs under the dedicated Vast SDK virtual environment so the SDK's
strict Pillow dependency cannot alter Vision Studio's Gradio environment.
One JSON request is read from stdin and one JSON response is written to stdout.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from vastai import CoroutineServerless


def _unwrap_sdk_result(result: object) -> dict:
    if not isinstance(result, dict):
        raise RuntimeError("Vast endpoint returned a non-object response.")
    if result.get("ok") is False:
        raise RuntimeError(str(result.get("error") or "Vast endpoint request failed."))
    nested = result.get("response")
    if isinstance(nested, str):
        try:
            nested = json.loads(nested)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Vast endpoint returned invalid response JSON.") from exc
    if isinstance(nested, dict):
        return nested
    return result


async def _request(message: dict) -> dict:
    api_key = os.environ.get("VAST_API_KEY", "")
    if len(api_key) < 24:
        raise RuntimeError("Vast API key is missing or invalid.")
    endpoint_name = message.get("endpoint")
    payload = message.get("payload")
    timeout = float(message.get("timeout", 1200))
    cost = int(message.get("cost", 100))
    if not isinstance(endpoint_name, str) or not endpoint_name.strip():
        raise RuntimeError("Vast endpoint name is missing.")
    if not isinstance(payload, dict):
        raise RuntimeError("Vast request payload must be an object.")
    if not 30 <= timeout <= 3600:
        raise RuntimeError("Vast request timeout is outside the allowed range.")
    if not 1 <= cost <= 16384:
        raise RuntimeError("Vast request workload is outside the allowed range.")

    async with CoroutineServerless(
        api_key=api_key,
        default_request_timeout=timeout,
    ) as client:
        endpoint = await client.get_endpoint(endpoint_name.strip())
        result = await endpoint.request(
            "/v1/chat/completions",
            payload,
            cost=cost,
            timeout=timeout,
            retry=True,
        )
    return _unwrap_sdk_result(result)


def main() -> int:
    try:
        message = json.loads(sys.stdin.read())
        if not isinstance(message, dict):
            raise RuntimeError("Bridge input must be a JSON object.")
        result = asyncio.run(_request(message))
        sys.stdout.write(json.dumps({"ok": True, "result": result}))
        return 0
    except Exception as exc:
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc)[:1000],
                    "error_type": type(exc).__name__,
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
