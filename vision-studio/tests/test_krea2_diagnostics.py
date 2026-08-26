from __future__ import annotations

import json
import unittest

from app.services.krea2_diagnostics import (
    DIAGNOSTIC_ENDPOINT,
    DIAGNOSTIC_SCHEMA,
    DIAGNOSTIC_TERMS_VERSION,
    Krea2DiagnosticReporter,
    Krea2OperationalErrorReporter,
    OPERATIONAL_ERROR_SCHEMA,
    sanitize_operational_error,
)


TOKEN = "test-only-token-1234567890-abcdef"


class FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload


class RecordingHttp:
    def __init__(self):
        self.calls = []
        self.report_sha256 = ""

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        metadata = json.loads(kwargs["data"]["metadata"])
        self.report_sha256 = metadata["report_sha256"]
        return FakeResponse(200, {
            "accepted": True,
            "duplicate": False,
            "report_sha256": self.report_sha256,
        })


class Krea2DiagnosticReporterTests(unittest.TestCase):
    def test_mandatory_operational_report_contains_no_user_content(self):
        class OperationalHttp:
            def __init__(self):
                self.calls = []

            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return FakeResponse(200, {
                    "accepted": True,
                    "report_sha256": kwargs["json"]["report_sha256"],
                })

        http = OperationalHttp()
        reporter = Krea2OperationalErrorReporter(TOKEN, http=http, attempts=1)
        accepted = reporter.submit_safely(
            event_id="c" * 32,
            model_id="vast::gemma4-26b-a4b-heretic-q3_k_l",
            pipeline_id="discord-faithful-v8-skin-pose-surface-lock",
            error_code="gpu_not_available",
            error_message="failed at C:\\Users\\person\\private.png token=secret-value https://private.example/image",
            stage="Waiting for remote worker",
            runtime="remote",
            plugin_version="0.13.17",
            backend_version="0.13.17",
        )
        self.assertTrue(accepted)
        payload = http.calls[0][1]["json"]
        self.assertEqual(http.calls[0][1]["headers"]["X-Krea2-Diagnostic-Contract"], OPERATIONAL_ERROR_SCHEMA)
        self.assertEqual(payload["error_code"], "gpu_not_available")
        self.assertNotIn("private.png", payload["error_message"])
        self.assertNotIn("secret-value", payload["error_message"])
        self.assertNotIn("private.example", payload["error_message"])
        for forbidden in ("image", "image_sha256", "prompt", "prompt_text", "discord_username", "guild_id", "channel_id", "message_id", "filename", "local_path"):
            self.assertNotIn(forbidden, payload)

    def test_operational_sanitizer_keeps_useful_public_error(self):
        self.assertEqual(sanitize_operational_error("GPU not available"), "GPU not available")

    def test_submits_explicit_failure_contract_from_memory_only(self):
        http = RecordingHttp()
        reporter = Krea2DiagnosticReporter(TOKEN, http=http, attempts=1)
        accepted = reporter.submit_safely(
            image_bytes=b"\xff\xd8\xff" + b"x" * 200,
            job_id="a" * 32,
            discord_username="garlicjr2",
            model_id="llamacpp::heretic-4b-q8_0",
            pipeline_id="discord-faithful-v8-skin-pose-surface-lock",
            error_code="output_validation_failed",
            error_message="Prompt formatting could not be repaired.",
            stage="Writing final prompt variations",
            prompt_text="An audited partial prompt.",
            plugin_version="0.13.7",
            backend_version="0.13.7",
        )
        self.assertTrue(accepted)
        self.assertEqual(len(http.calls), 1)
        url, kwargs = http.calls[0]
        self.assertEqual(url, DIAGNOSTIC_ENDPOINT)
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["headers"]["X-Krea2-Diagnostic-Contract"], DIAGNOSTIC_SCHEMA)
        self.assertEqual(kwargs["headers"]["X-Krea2-Diagnostic-Terms"], DIAGNOSTIC_TERMS_VERSION)
        payload = json.loads(kwargs["data"]["metadata"])
        self.assertEqual(payload["discord_username"], "garlicjr2")
        self.assertEqual(payload["prompt_text"], "An audited partial prompt.")
        self.assertRegex(payload["image_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(payload["source_instance_sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn(TOKEN, kwargs["data"]["metadata"])
        for forbidden in ("guild_id", "channel_id", "message_id", "attachment_url", "local_path"):
            self.assertNotIn(forbidden, payload)

    def test_transport_failure_is_nonfatal_and_bounded(self):
        class FailingHttp:
            def post(self, *_args, **_kwargs):
                raise RuntimeError("offline")

        reporter = Krea2DiagnosticReporter(TOKEN, http=FailingHttp(), attempts=1)
        accepted = reporter.submit_safely(
            image_bytes=b"\xff\xd8\xffx",
            job_id="b" * 32,
            discord_username="tester",
            model_id="model",
            pipeline_id="pipeline",
            error_code="backend_error",
            error_message="backend unavailable",
            stage="shared GPU handoff",
            prompt_text=None,
            plugin_version="1",
            backend_version="1",
        )
        self.assertFalse(accepted)


if __name__ == "__main__":
    unittest.main()
