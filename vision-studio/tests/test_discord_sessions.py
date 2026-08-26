from __future__ import annotations

import unittest
from unittest.mock import patch

from app.models.remote_access import RemoteAccess
from app.services.discord_sessions import DiscordVisionSessionStore


class DiscordVisionSessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = DiscordVisionSessionStore(ttl_seconds=30, maximum_sessions=16)
        self.key = "a" * 64
        self.version = "0.10.0"
        self.model = "vast::gemma4-26b-a4b-heretic-q3_k_l"

    def _remote_access(self):
        return RemoteAccess(
            license_id="lic_" + "x" * 18,
            license_token="t" * 48,
            discord_user_id="123456789012345678",
            discord_username="test-user",
            request_id=self.key,
        )

    def test_session_is_bound_and_consumed_exactly_once(self):
        token, ttl = self.store.issue(self.key, self.version, self.model, self._remote_access())
        self.assertEqual(ttl, 30)
        self.assertGreaterEqual(len(token), 32)
        self.assertFalse(self.store.consume(token, "b" * 64, self.version, self.model))
        self.assertFalse(self.store.consume(token, self.key, self.version, self.model))

        token, _ = self.store.issue(self.key, self.version, self.model, self._remote_access())
        self.assertTrue(self.store.consume(token, self.key, self.version, self.model))
        self.assertFalse(self.store.consume(token, self.key, self.version, self.model))

    def test_expired_session_is_rejected(self):
        with patch("app.services.discord_sessions.time.monotonic", side_effect=[10.0, 41.0]):
            token, _ = self.store.issue(self.key, self.version, self.model, self._remote_access())
            self.assertFalse(self.store.consume(token, self.key, self.version, self.model))

    def test_invalid_binding_is_rejected_before_issue(self):
        with self.assertRaises(ValueError):
            self.store.issue("short", self.version, self.model)
        with self.assertRaises(ValueError):
            self.store.issue(self.key, "", self.model)
        with self.assertRaises(ValueError):
            self.store.issue(self.key, self.version, "")
        with self.assertRaises(ValueError):
            self.store.issue(self.key, self.version, self.model)


if __name__ == "__main__":
    unittest.main()
