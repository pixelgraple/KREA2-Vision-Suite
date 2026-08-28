from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.krea2_contributions import (
    CONTRIBUTION_ENDPOINT,
    CONTRIBUTION_SCHEMA,
    CONTRIBUTION_TERMS_VERSION,
    Krea2ContributionError,
    Krea2PromptContributor,
)


TOKEN = "test-only-token-1234567890-abcdef"


def prompt(index: int) -> str:
    words = [f"variant{index}", "visible", "subject", "pose", "lighting", "background"]
    return " ".join(words[i % len(words)] for i in range(400)) + "."


class FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


class RecordingHttp:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class Krea2ContributionTests(unittest.TestCase):
    def result(self):
        return SimpleNamespace(
            prompt_variants=[prompt(1), prompt(2), prompt(3)],
            model="Heretic Qwen3-VL 8B Q8_0",
            pipeline_id="discord-faithful-v4-pose-anatomy-lock",
        )

    def test_submits_exact_three_prompt_contract_without_image_or_discord_data(self):
        http = RecordingHttp([])
        contributor = Krea2PromptContributor(TOKEN, http=http, attempts=1)
        result = self.result()
        expected_prompts = result.prompt_variants
        from app.services.krea2_contributions import _canonical_batch, _sha256_text
        expected_batch = _sha256_text(
            _canonical_batch(result.model, result.pipeline_id, expected_prompts)
        )
        http.responses = iter([
            FakeResponse(200, {
                "accepted": True,
                "duplicate": False,
                "batch_sha256": expected_batch,
                "accepted_count": 3,
                "dataset_revision": 91,
                "rights_status": "review_required",
                "training_ready": False,
            })
        ])

        receipt = contributor.submit(result)

        self.assertEqual(receipt.batch_sha256, expected_batch)
        self.assertEqual(receipt.dataset_revision, 91)
        self.assertFalse(receipt.duplicate)
        self.assertEqual(len(http.calls), 1)
        url, kwargs = http.calls[0]
        self.assertEqual(url, CONTRIBUTION_ENDPOINT)
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["headers"]["X-Krea2-Contribution-Contract"], CONTRIBUTION_SCHEMA)
        self.assertEqual(kwargs["headers"]["X-Krea2-Terms-Version"], CONTRIBUTION_TERMS_VERSION)
        payload = json.loads(kwargs["data"])
        self.assertEqual(payload["prompt_variants"], expected_prompts)
        self.assertEqual(payload["terms_accepted"], True)
        self.assertRegex(payload["source_instance_sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn(TOKEN, kwargs["data"].decode("utf-8"))
        for forbidden in ("image", "discord", "filename", "path", "url"):
            self.assertNotIn(forbidden, payload)

    def test_retries_only_in_memory_and_requires_authoritative_receipt(self):
        result = self.result()
        from app.services.krea2_contributions import _canonical_batch, _sha256_text
        expected_batch = _sha256_text(
            _canonical_batch(result.model, result.pipeline_id, result.prompt_variants)
        )
        http = RecordingHttp([
            FakeResponse(503, {}),
            FakeResponse(200, {
                "accepted": True,
                "duplicate": True,
                "batch_sha256": expected_batch,
                "accepted_count": 3,
                "dataset_revision": 92,
                "rights_status": "review_required",
                "training_ready": False,
            }),
        ])
        contributor = Krea2PromptContributor(TOKEN, http=http, attempts=2)
        with patch("app.services.krea2_contributions._retry_sleep") as sleep:
            receipt = contributor.submit(result)
        self.assertTrue(receipt.duplicate)
        self.assertEqual(len(http.calls), 2)
        sleep.assert_called_once()

        invalid = RecordingHttp([FakeResponse(200, {"accepted": True})])
        with self.assertRaises(Krea2ContributionError):
            Krea2PromptContributor(TOKEN, http=invalid, attempts=1).submit(result)

    def test_rejects_noncanonical_endpoint_and_incomplete_prompt_set(self):
        with self.assertRaises(ValueError):
            Krea2PromptContributor(TOKEN, endpoint="https://example.com/upload")
        contributor = Krea2PromptContributor(TOKEN, http=RecordingHttp([]), attempts=1)
        result = self.result()
        result.prompt_variants = result.prompt_variants[:2]
        with self.assertRaises(Krea2ContributionError):
            contributor.submit(result)

if __name__ == "__main__":
    unittest.main()
