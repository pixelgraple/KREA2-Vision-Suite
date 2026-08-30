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
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self.body = body

    def json(self) -> dict:
        return self.body


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
        with self.guard:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.04)
            payload = kwargs["json"]
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


if __name__ == "__main__":
    unittest.main()
