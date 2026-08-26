from __future__ import annotations

import errno
import ipaddress
import json
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import requests

from .shared_queue import QueueLease


HANDOFF_HEADER = "X-BabeGen-Queue-Token"
HANDOFF_TICKET_HEADER = "X-BabeGen-Queue-Ticket"
HANDOFF_NONCE_HEADER = "X-BabeGen-Queue-Nonce"
HANDOFF_PATH = "/sdapi/v1/unload-checkpoint-held"


class ForgeHandoffError(RuntimeError):
    pass


def _literal_loopback_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        return (
            parsed.scheme in {"http", "https"}
            and parsed.username is None
            and parsed.password is None
            and ipaddress.ip_address(host).is_loopback
        )
    except (ValueError, TypeError):
        return False


def _connection_refused(exc: BaseException) -> bool:
    """Find a real ECONNREFUSED through requests/urllib3 exception wrappers."""

    pending: list[BaseException] = [exc]
    seen: set[int] = set()
    refused_codes = {errno.ECONNREFUSED, 10061}
    while pending:
        current = pending.pop()
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        if isinstance(current, OSError):
            codes = {getattr(current, "errno", None), getattr(current, "winerror", None)}
            if codes & refused_codes:
                return True
        for nested in (
            getattr(current, "__cause__", None),
            getattr(current, "__context__", None),
            getattr(current, "reason", None),
        ):
            if isinstance(nested, BaseException):
                pending.append(nested)
        for argument in getattr(current, "args", ()):
            if isinstance(argument, BaseException):
                pending.append(argument)
    return False


def load_handoff_token(path: str | Path) -> str:
    """Read the existing shared Forge credential without creating or logging it."""

    token_path = Path(path).expanduser()
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ForgeHandoffError("The Forge handoff credential is unavailable.") from exc
    if len(token.encode("utf-8")) < 32:
        raise ForgeHandoffError("The Forge handoff credential is invalid.")
    return token


class ForgeVramHandoff:
    """Unload Forge only while this process proves ownership of the queue head."""

    def __init__(
        self,
        urls: str,
        queue_dir: str = "",
        timeout_seconds: float = 45,
        token_file: str | Path = "",
        *,
        handoff_token: str | None = None,
        http=None,
    ):
        self.urls = [url.strip().rstrip("/") for url in urls.split(",") if url.strip()]
        self.queue_dir = Path(queue_dir) if queue_dir else Path(tempfile.gettempdir()) / "forge_shared_generation_queue"
        self.timeout_seconds = max(5.0, timeout_seconds)
        self.token_file = token_file
        self._handoff_token = handoff_token
        self.http = http or requests

    def _token(self) -> str:
        token = self._handoff_token if self._handoff_token is not None else load_handoff_token(self.token_file)
        if len(token.encode("utf-8")) < 32:
            raise ForgeHandoffError("The Forge handoff credential is invalid.")
        return token

    def unload_forge_models(self, lease: QueueLease | None) -> dict:
        if lease is None:
            raise ForgeHandoffError("A live shared-queue lease is required for Forge handoff.")
        token = self._token()
        result = {"requested": self.urls, "unloaded": [], "offline": []}
        failures: list[str] = []
        headers = {
            HANDOFF_HEADER: token,
            HANDOFF_TICKET_HEADER: lease.ticket_name,
            HANDOFF_NONCE_HEADER: lease.nonce,
        }
        for base_url in self.urls:
            endpoint = f"{base_url}{HANDOFF_PATH}"
            try:
                response = self.http.post(endpoint, json={}, headers=headers, timeout=self.timeout_seconds)
                response.raise_for_status()
                result["unloaded"].append(base_url)
            except requests.ConnectionError as exc:
                # Only a literal-loopback ECONNREFUSED proves that this
                # configured Forge process is stopped. Resets, early closes,
                # DNS/proxy failures and connect timeouts are not confirmation.
                if (
                    not isinstance(exc, requests.Timeout)
                    and _literal_loopback_url(base_url)
                    and _connection_refused(exc)
                ):
                    result["offline"].append(base_url)
                else:
                    failures.append(base_url)
            except requests.RequestException:
                # Timeouts after connecting and HTTP/protocol errors mean a
                # reachable endpoint did not confirm the ownership handoff.
                failures.append(base_url)
        if failures:
            raise ForgeHandoffError(
                "Reachable Forge endpoint(s) did not confirm safe VRAM handoff: "
                + ", ".join(failures)
            )
        return result

    def queued_forge_jobs(self) -> list[dict]:
        jobs = []
        for ticket in sorted(self.queue_dir.glob("*.ticket")):
            try:
                payload = json.loads(ticket.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            instance = str(payload.get("instance", ""))
            normalized = instance.lower()
            if instance and "prompt-assistant" not in normalized and "krea2-vision-studio" not in normalized:
                jobs.append({"instance": instance, "ticket": ticket.name})
        return jobs
