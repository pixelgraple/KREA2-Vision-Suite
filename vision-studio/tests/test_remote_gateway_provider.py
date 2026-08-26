from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image
import requests

from app.models.remote_access import RemoteAccess
from app.models.remote_gateway_provider import RemoteGatewayProvider


class _Response:
    def __init__(self, status_code: int, body: dict):
        self.status_code, self._body = status_code, body

    def json(self):
        return self._body


class _Http:
    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith("/v1/chat/completions"):
            return _Response(200, {"choices":[{"message":{"content":"pixel-grounded response"}}], "usage":{"completion_tokens":3}})
        return _Response(200, {"accepted":True})


class _TransientHttp(_Http):
    def __init__(self):
        super().__init__()
        self.failures_remaining = 1

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith("/v1/chat/completions") and self.failures_remaining:
            self.failures_remaining -= 1
            raise requests.ConnectionError("transient connection close")
        if url.endswith("/v1/chat/completions"):
            return _Response(200, {"choices":[{"message":{"content":"reconnected result"}}]})
        return _Response(200, {"accepted":True})


class RemoteGatewayProviderTests(unittest.TestCase):
    def setUp(self):
        self.access = RemoteAccess(
            license_id="lic_" + "x" * 18,
            license_token="t" * 48,
            request_id="a" * 64,
            source_url="https://cdn.discordapp.com/attachments/123/456/source.png",
        )
        self.http = _Http()
        self.provider = RemoteGatewayProvider(
            base_url="https://seedframe.xyz/api/krea2-vision",
            model="gemma4-26b-a4b-heretic-q3-k-l",
            max_tokens=2048,
            timeout=1200,
            access=self.access,
            http=self.http,
        )

    def test_forwards_only_license_proof_and_request_bound_image_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "sample.png"
            Image.new("RGB", (4, 4), "red").save(image)
            reply = self.provider.with_image_text("system", "inspect", str(image), 0.1, 512)
        self.assertEqual(reply.text, "pixel-grounded response")
        url, request = self.http.calls[0]
        self.assertEqual(url, "https://seedframe.xyz/api/krea2-vision/v1/chat/completions")
        self.assertEqual(request["headers"]["Authorization"], self.access.authorization)
        self.assertNotIn("X-Krea2-Discord-User", request["headers"])
        self.assertEqual(request["headers"]["X-Krea2-Request-Id"], self.access.request_id)
        self.assertNotIn("vast", str(request["headers"]).lower())
        self.assertTrue(request["json"]["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_completion_posts_no_image_bytes(self):
        self.provider.complete_audit(["x " * 700, "y " * 700, "z " * 700])
        url, request = self.http.calls[0]
        self.assertEqual(url, "https://seedframe.xyz/api/krea2-vision/v1/audit/complete")
        self.assertEqual(request["json"]["source_url"], self.access.source_url)
        self.assertNotIn("data:image", str(request["json"]))

    def test_retries_one_transient_gateway_disconnect_with_same_request_proof(self):
        self.provider.http = _TransientHttp()
        reply = self.provider.text("system", "describe", 0.1, 64)
        self.assertEqual(reply.text, "reconnected result")
        self.assertEqual(len(self.provider.http.calls), 2)
        for _, request in self.provider.http.calls:
            self.assertEqual(request["headers"]["X-Krea2-Request-Id"], self.access.request_id)


if __name__ == "__main__":
    unittest.main()
