from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
from dataclasses import dataclass
from time import monotonic as _session_monotonic

from ..models.remote_access import RemoteAccess


@dataclass(frozen=True)
class DiscordVisionSession:
    expires_at: float
    idempotency_key: str
    collector_version: str
    model: str
    remote_access: RemoteAccess | None = None


class DiscordVisionSessionStore:
    """In-memory, one-use authorization for a single BetterDiscord image request."""

    def __init__(self, ttl_seconds: int = 120, maximum_sessions: int = 512):
        self.ttl_seconds = max(15, min(300, int(ttl_seconds)))
        self.maximum_sessions = max(16, min(4096, int(maximum_sessions)))
        self._sessions: dict[str, DiscordVisionSession] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _validate_binding(idempotency_key: str, collector_version: str, model: str) -> tuple[str, str, str]:
        normalized_key = str(idempotency_key or "").strip().lower()
        normalized_version = str(collector_version or "").strip()
        normalized_model = str(model or "").strip()
        if len(normalized_key) != 64 or any(character not in "0123456789abcdef" for character in normalized_key):
            raise ValueError("A 64-character hexadecimal idempotency key is required.")
        if not normalized_version or len(normalized_version) > 64 or any(ord(character) < 33 or ord(character) > 126 for character in normalized_version):
            raise ValueError("A valid collector version is required.")
        if not normalized_model or len(normalized_model) > 200 or any(ord(character) < 32 or ord(character) == 127 for character in normalized_model):
            raise ValueError("A valid Vision model ID is required.")
        return normalized_key, normalized_version, normalized_model

    def _prune_locked(self, now: float) -> None:
        for digest, session in list(self._sessions.items()):
            if session.expires_at <= now:
                self._sessions.pop(digest, None)
        while len(self._sessions) >= self.maximum_sessions:
            oldest = min(self._sessions, key=lambda item: self._sessions[item].expires_at)
            self._sessions.pop(oldest, None)

    def issue(self, idempotency_key: str, collector_version: str, model: str, remote_access: RemoteAccess | None = None) -> tuple[str, int]:
        normalized_key, normalized_version, normalized_model = self._validate_binding(
            idempotency_key,
            collector_version,
            model,
        )
        if normalized_model.startswith("vast::"):
            if remote_access is None:
                raise ValueError("Online API Vision requires a remote KREA2 license.")
            remote_access.validate()
        elif remote_access is not None:
            raise ValueError("Remote KREA2 access may only be used with the Online API model.")
        token = secrets.token_urlsafe(48)
        now = _session_monotonic()
        with self._lock:
            self._prune_locked(now)
            self._sessions[self._digest(token)] = DiscordVisionSession(
                expires_at=now + self.ttl_seconds,
                idempotency_key=normalized_key,
                collector_version=normalized_version,
                model=normalized_model,
                remote_access=remote_access,
            )
        return token, self.ttl_seconds

    def consume_record(self, token: str, idempotency_key: str, collector_version: str, model: str) -> DiscordVisionSession | None:
        try:
            normalized_key, normalized_version, normalized_model = self._validate_binding(
                idempotency_key,
                collector_version,
                model,
            )
        except ValueError:
            return None
        supplied = str(token or "").strip()
        if len(supplied) < 32 or len(supplied) > 512:
            return None
        now = _session_monotonic()
        with self._lock:
            self._prune_locked(now)
            session = self._sessions.pop(self._digest(supplied), None)
        if not session or session.expires_at <= now:
            return None
        if not (
            hmac.compare_digest(session.idempotency_key, normalized_key)
            and hmac.compare_digest(session.collector_version, normalized_version)
            and hmac.compare_digest(session.model, normalized_model)
        ):
            return None
        return session

    def consume(self, token: str, idempotency_key: str, collector_version: str, model: str) -> bool:
        return self.consume_record(token, idempotency_key, collector_version, model) is not None

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()
