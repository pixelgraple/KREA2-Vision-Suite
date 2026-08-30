from __future__ import annotations

import unittest

from app.models.remote_gateway_provider import RemoteGatewayErrorReporter
from app.services.discord_error_reports import exception_trace, redact_technical_trace


class FakeResponse:
    status_code = 200

    def json(self):
        return {"accepted": True, "duplicate": False}


class FakeHttp:
    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return FakeResponse()


class DiscordErrorReportTests(unittest.TestCase):
    def test_trace_keeps_exception_chain_and_redacts_private_values(self):
        try:
            try:
                raise ValueError(
                    "Authorization: Bearer private-token "
                    "prompt_text: secret image prompt "
                    "https://cdn.discordapp.com/attachments/private/source.png"
                )
            except ValueError as cause:
                raise RuntimeError(r"C:\Users\ExampleUser\Documents\kreainterrogate\app\worker.py failed") from cause
        except RuntimeError as error:
            report = exception_trace(error)

        self.assertIn("ValueError", report)
        self.assertIn("RuntimeError", report)
        self.assertIn("worker.py", report)
        for forbidden in ("private-token", "secret image prompt", "cdn.discordapp.com", "source.png", "ExampleUser"):
            self.assertNotIn(forbidden, report)

    def test_reporter_posts_authenticated_bounded_json_without_redirects(self):
        http = FakeHttp()
        reporter = RemoteGatewayErrorReporter(base_url="https://seedframe.xyz/api/krea2-vision", http=http)
        accepted = reporter.submit_safely(
            license_id="lic_error_report_test",
            license_token="t" * 64,
            event_id="f" * 32,
            model_id="vast::gemma4-26b-a4b-heretic-q3_k_l",
            pipeline_id="discord-faithful-v12-interaction-locked-v2",
            error_code="vision_backend_unavailable",
            error_message="worker failed",
            stage="Running remote inference",
            runtime="remote",
            plugin_version="0.14.3",
            backend_version="0.14.3",
            technical_trace=redact_technical_trace("RuntimeError: worker failed"),
        )

        self.assertTrue(accepted)
        self.assertEqual(len(http.calls), 1)
        url, kwargs = http.calls[0]
        self.assertEqual(url, "https://seedframe.xyz/api/krea2-vision/v1/audit/error")
        self.assertEqual(kwargs["headers"]["Authorization"], f"Krea2License lic_error_report_test.{('t' * 64)}")
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["json"]["event_id"], "f" * 32)

    def test_reporter_rejects_missing_credentials_without_transport(self):
        http = FakeHttp()
        reporter = RemoteGatewayErrorReporter(base_url="https://seedframe.xyz/api/krea2-vision", http=http)
        accepted = reporter.submit_safely(
            license_id="bad",
            license_token="short",
            event_id="f" * 32,
            model_id="unknown",
            pipeline_id="unknown",
            error_code="test",
            error_message="test",
            stage="test",
            runtime="local",
            plugin_version="test",
            backend_version="test",
            technical_trace="test",
        )
        self.assertFalse(accepted)
        self.assertEqual(http.calls, [])


if __name__ == "__main__":
    unittest.main()
