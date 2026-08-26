from __future__ import annotations

import hashlib
import json
import unittest

from app.services.feedback_guidance import FEEDBACK_SCHEMA, parse_feedback_context


def _prompt(label: str) -> str:
    return (f"{label} grounded visual prompt with subject pose camera framing clothing texture lighting and background detail. " * 8).strip()


def _example(label: str, *, reason: str = "") -> dict:
    prompt = _prompt(label)
    value = {"id": hashlib.sha256(prompt.encode("utf-8")).hexdigest(), "prompt": prompt}
    if reason:
        value["reason"] = reason
    return value


class PromptFeedbackGuidanceTests(unittest.TestCase):
    def test_default_off_rejects_payload_and_empty_is_inert(self):
        context = parse_feedback_context("", enabled=False)
        self.assertFalse(context.enabled)
        self.assertEqual(context.composer_guidance, "")
        with self.assertRaisesRegex(ValueError, "requires Krea2 dataset guidance"):
            parse_feedback_context(json.dumps({"schema": FEEDBACK_SCHEMA}), enabled=False)

    def test_enabled_context_accepts_four_liked_three_disliked_and_is_bounded(self):
        payload = {
            "schema": FEEDBACK_SCHEMA,
            "liked": [_example(f"liked-{index}") for index in range(4)],
            "disliked": [
                _example(f"disliked-{index}", reason=f"avoid issue {index}")
                for index in range(3)
            ],
            "blocked_sample_digests": ["a" * 64, "b" * 64],
        }
        context = parse_feedback_context(json.dumps(payload), enabled=True)
        self.assertTrue(context.enabled)
        self.assertEqual(context.liked_count, 4)
        self.assertEqual(context.disliked_count, 3)
        self.assertEqual(context.blocked_sample_digests, frozenset({"a" * 64, "b" * 64}))
        self.assertRegex(context.digest, r"^[a-f0-9]{64}$")
        self.assertIn("100% authoritative", context.composer_guidance)
        self.assertIn("AVOIDANCE REASON: avoid issue 2", context.composer_guidance)
        self.assertLess(len(context.composer_guidance), 4_500)

    def test_digest_is_stable_and_contains_no_prompt_or_reason_text(self):
        payload = {
            "schema": FEEDBACK_SCHEMA,
            "liked": [_example("private-liked")],
            "disliked": [_example("private-disliked", reason="private reason")],
            "blocked_sample_digests": ["c" * 64],
        }
        first = parse_feedback_context(json.dumps(payload), enabled=True)
        second = parse_feedback_context(json.dumps(payload), enabled=True)
        self.assertEqual(first.digest, second.digest)
        metadata = json.dumps(
            {
                "feedback_digest": first.digest,
                "liked_count": first.liked_count,
                "disliked_count": first.disliked_count,
                "blocked_sample_count": len(first.blocked_sample_digests),
            }
        )
        self.assertNotIn("private-liked", metadata)
        self.assertNotIn("private reason", metadata)

    def test_invalid_identity_reason_and_count_fail_closed(self):
        bad_id = _example("bad-id")
        bad_id["id"] = "0" * 64
        cases = [
            {"schema": FEEDBACK_SCHEMA, "liked": [bad_id], "disliked": [], "blocked_sample_digests": []},
            {"schema": FEEDBACK_SCHEMA, "liked": [], "disliked": [_example("bad-reason") | {"reason": "x"}], "blocked_sample_digests": []},
            {"schema": FEEDBACK_SCHEMA, "liked": [_example(str(index)) for index in range(5)], "disliked": [], "blocked_sample_digests": []},
        ]
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_feedback_context(json.dumps(payload), enabled=True)


if __name__ == "__main__":
    unittest.main()
