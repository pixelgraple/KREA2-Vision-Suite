from __future__ import annotations

import asyncio
import hashlib
import tempfile
import threading
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app import Config, Gateway, create_app


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        body: dict,
        *,
        headers: dict[str, str] | None = None,
        chunks: list[bytes] | None = None,
    ):
        self.status_code = status_code
        self.body = body
        self.headers = headers or {"Content-Type": "application/json"}
        self.chunks = chunks or []
        self.closed = False

    def json(self) -> dict:
        return self.body

    def iter_content(self, *, chunk_size: int):
        assert chunk_size == 256
        yield from self.chunks

    def close(self):
        self.closed = True


class RecordingDedicatedHttp:
    def __init__(self):
        self.models: list[str] = []
        self.active = 0
        self.max_active = 0
        self.guard = threading.Lock()
        self.failure_response: FakeResponse | None = None

    def get(self, url: str, **kwargs):
        return FakeResponse(
            200,
            {
                "object": "list",
                "data": [
                    {"id": "gemma4-26b-a4b-heretic-q3-k-l"},
                    {"id": "qwen38-27b-heretic-q4-k-m"},
                ],
            },
        )

    def post(self, url: str, **kwargs):
        if self.failure_response is not None:
            return self.failure_response
        payload = kwargs["json"]
        if kwargs.get("stream"):
            self.models.append(payload["model"])
            return FakeResponse(
                200,
                {},
                headers={"Content-Type": "text/event-stream; charset=utf-8"},
                chunks=[
                    b'data: {"id":"chatcmpl-stream","choices":[{"delta":{"content":"TOKEN_ONE "},"finish_reason":null}]}\n\n',
                    b'data: {"id":"chatcmpl-stream","choices":[{"delta":{"content":"TOKEN_TWO"},"finish_reason":null}]}\n\n',
                    b'data: {"id":"chatcmpl-stream","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                    b"data: [DONE]\n\n",
                ],
            )
        with self.guard:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.04)
            self.models.append(payload["model"])
            return FakeResponse(
                200,
                {
                    "id": "chatcmpl-dedicated-test",
                    "object": "chat.completion",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "A complete dedicated response.",
                            },
                            "finish_reason": "stop",
                        }
                    ],
                },
            )
        finally:
            with self.guard:
                self.active -= 1


class DedicatedRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.http = RecordingDedicatedHttp()
        self.gateway = Gateway(
            Config(
                database=Path(self.temp.name) / "gateway.sqlite3",
                vast_endpoint="",
                vast_api_key="",
                audit_webhook_url="",
                admin_key="a" * 64,
                request_timeout_seconds=120,
                max_request_bytes=32 * 1024 * 1024,
                retention_days=30,
                discord_client_id="",
                discord_client_secret="",
                discord_redirect_uri="",
                license_signing_key="s" * 64,
                dedicated_base_url="http://127.0.0.1:18090",
                dedicated_api_key="d" * 64,
                openwebui_bridge_api_key="d" * 64,
            ),
            http=self.http,
        )

    def tearDown(self):
        self.temp.cleanup()

    async def test_health_and_shared_gpu_queue(self):
        readiness = await self.gateway.remote_readiness()
        self.assertEqual(readiness["ready_workers"], 1)
        self.assertEqual(readiness["recovery_status"], "dedicated-ready")

        vision = {
            "model": "ignored",
            "messages": [{"role": "user", "content": "Describe this image."}],
            "max_tokens": 128,
        }
        qwen = {
            "model": "ignored",
            "messages": [{"role": "user", "content": "Revise this prompt."}],
            "max_tokens": 128,
        }
        await asyncio.gather(
            self.gateway._dedicated_completion(
                vision,
                model="gemma4-26b-a4b-heretic-q3-k-l",
                timeout_seconds=30,
            ),
            self.gateway._dedicated_completion(
                qwen,
                model="qwen38-27b-heretic-q4-k-m",
                timeout_seconds=30,
            ),
        )
        self.assertEqual(self.http.max_active, 1)
        self.assertEqual(
            self.http.models,
            [
                "gemma4-26b-a4b-heretic-q3-k-l",
                "qwen38-27b-heretic-q4-k-m",
            ],
        )
        self.assertEqual(self.gateway._dedicated_queue_depth, 0)

    async def test_openwebui_upstream_rejection_is_bounded_json_not_plain_text_500(self):
        self.http.failure_response = FakeResponse(
            400,
            {"error": {"message": "System message must be at the beginning"}},
        )
        client = TestClient(create_app(self.gateway.config, http=self.http))
        response = client.post(
            "/v1/openwebui/chat/completions",
            headers={"Authorization": f"Bearer {('d' * 64)}"},
            json={
                "model": "heretic-3.8-q4-cloud",
                "messages": [{"role": "user", "content": "Continue the old chat."}],
                "max_tokens": 64,
            },
        )
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.headers["content-type"], "application/json")
        self.assertIn("Dedicated Qwen rejected", response.json()["detail"])
        self.assertNotIn("System message", response.text)

    async def test_openwebui_stream_retains_lock_until_sse_is_exhausted(self):
        stream = await self.gateway._dedicated_completion_stream(
            {
                "messages": [{"role": "user", "content": "Stream two tokens."}],
                "max_tokens": 64,
            },
            model="qwen38-27b-heretic-q4-k-m",
            timeout_seconds=30,
        )
        self.assertTrue(self.gateway._dedicated_inference_lock.locked())
        self.assertEqual(self.gateway._dedicated_queue_depth, 1)

        chunks = [chunk async for chunk in stream]
        text = b"".join(chunks).decode("utf-8")
        self.assertIn("TOKEN_ONE", text)
        self.assertIn("TOKEN_TWO", text)
        self.assertEqual(text.count("data: [DONE]"), 1)
        self.assertFalse(self.gateway._dedicated_inference_lock.locked())
        self.assertEqual(self.gateway._dedicated_queue_depth, 0)

        client = TestClient(create_app(self.gateway.config, http=self.http))
        with client.stream(
            "POST",
            "/v1/openwebui/chat/completions",
            headers={"Authorization": f"Bearer {('d' * 64)}"},
            json={
                "model": "heretic-3.8-q4-cloud",
                "messages": [{"role": "user", "content": "Stream through the route."}],
                "max_tokens": 64,
                "stream": True,
            },
        ) as response:
            routed = "".join(response.iter_text())
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])
        self.assertEqual(routed.count("data: [DONE]"), 1)
        self.assertIn("TOKEN_ONE", routed)
        self.assertIn("TOKEN_TWO", routed)


if __name__ == "__main__":
    unittest.main()
