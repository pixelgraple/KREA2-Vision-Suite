from __future__ import annotations

import errno
import ipaddress
from urllib.parse import urlsplit

import requests

from .shared_queue import QueueLease


class OllamaHandoffError(RuntimeError):
    pass


def _literal_loopback_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme in {"http", "https"}
            and parsed.username is None
            and parsed.password is None
            and ipaddress.ip_address(parsed.hostname or "").is_loopback
        )
    except (TypeError, ValueError):
        return False


def _connection_refused(exc: BaseException) -> bool:
    pending = [exc]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, OSError) and {
            getattr(current, "errno", None),
            getattr(current, "winerror", None),
        } & {errno.ECONNREFUSED, 10061}:
            return True
        for nested in (
            getattr(current, "__cause__", None),
            getattr(current, "__context__", None),
            getattr(current, "reason", None),
        ):
            if isinstance(nested, BaseException):
                pending.append(nested)
        pending.extend(item for item in getattr(current, "args", ()) if isinstance(item, BaseException))
    return False


class OllamaVramHandoff:
    """Unload resident Ollama runners while a caller owns the shared GPU FIFO."""

    def __init__(self, base_url: str, timeout_seconds: float = 45, *, http=None):
        self.base_url = str(base_url).strip().rstrip("/")
        self.timeout_seconds = max(5.0, min(float(timeout_seconds), 120.0))
        self.http = http or requests
        if not _literal_loopback_url(self.base_url):
            raise OllamaHandoffError("Ollama VRAM handoff requires a literal loopback URL.")

    def unload_models(self, lease: QueueLease | None) -> dict:
        if lease is None:
            raise OllamaHandoffError("A live shared-queue lease is required for Ollama handoff.")
        try:
            response = self.http.get(f"{self.base_url}/api/ps", timeout=self.timeout_seconds)
            response.raise_for_status()
            payload = response.json()
        except requests.ConnectionError as exc:
            if not isinstance(exc, requests.Timeout) and _connection_refused(exc):
                return {"offline": True, "unloaded": []}
            raise OllamaHandoffError("Ollama did not confirm its resident model list.") from exc
        except (requests.RequestException, TypeError, ValueError, AttributeError) as exc:
            raise OllamaHandoffError("Ollama did not confirm its resident model list.") from exc

        entries = payload.get("models", []) if isinstance(payload, dict) else []
        if not isinstance(entries, list):
            raise OllamaHandoffError("Ollama returned an invalid resident model list.")
        names: list[str] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("model")
            if isinstance(name, str) and 0 < len(name) <= 256 and name not in names:
                names.append(name)
        unloaded: list[str] = []
        for name in names:
            try:
                response = self.http.post(
                    f"{self.base_url}/api/generate",
                    json={"model": name, "prompt": "", "stream": False, "keep_alive": 0},
                    timeout=self.timeout_seconds,
                )
                response.raise_for_status()
            except requests.RequestException as exc:
                raise OllamaHandoffError("Ollama could not confirm resident-model VRAM release.") from exc
            unloaded.append(name)
        return {"offline": False, "unloaded": unloaded}
