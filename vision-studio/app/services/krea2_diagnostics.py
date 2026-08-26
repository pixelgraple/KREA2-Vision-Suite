from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import unicodedata
from pathlib import Path
from typing import Any

import requests


DIAGNOSTIC_ENDPOINT = "https://seedframe.xyz/api/diagnostics/krea2-vision"
DIAGNOSTIC_SCHEMA = "seedframe.krea2-vision-diagnostic.v1"
DIAGNOSTIC_TERMS_VERSION = "seedframe-krea2-vision-diagnostics-2026-08-25"
DIAGNOSTIC_USER_AGENT = "Krea2VisionBackend/1.0"
OPERATIONAL_ERROR_SCHEMA = "seedframe.krea2-vision-operational-error.v1"
OPERATIONAL_ERROR_NOTICE_VERSION = "seedframe-krea2-vision-operational-errors-2026-08-26"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
log = logging.getLogger("studio.krea2_diagnostics")

_URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)
_WINDOWS_PATH_RE = re.compile(r"\b[A-Za-z]:\\[^\r\n\t]+")
_TOKEN_RE = re.compile(r"(?i)\b(?:token|secret|password|authorization|api[_ -]?key)\s*[:=]\s*\S+")
_LONG_HEX_RE = re.compile(r"\b[0-9a-fA-F]{24,}\b")


def _clean(value: object, maximum: int) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    normalized = " ".join(normalized.split())
    if not normalized or len(normalized) > maximum:
        raise ValueError("Diagnostic text is missing or too long.")
    return normalized


def _canonical_report(payload: dict[str, Any]) -> str:
    return json.dumps(
        [
            DIAGNOSTIC_SCHEMA,
            DIAGNOSTIC_TERMS_VERSION,
            payload["source_instance_sha256"],
            payload["job_id"],
            payload["discord_username"],
            payload["model_id"],
            payload["pipeline_id"],
            payload["error_code"],
            payload["error_message"],
            payload["stage"],
            payload["prompt_text"],
            payload["image_sha256"],
            payload["plugin_version"],
            payload["backend_version"],
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def sanitize_operational_error(value: object, maximum: int = 600) -> str:
    """Keep a useful error while removing paths, URLs, credentials, and opaque IDs."""

    normalized = unicodedata.normalize("NFKC", str(value or ""))
    normalized = _TOKEN_RE.sub("[credential removed]", normalized)
    normalized = _URL_RE.sub("[URL removed]", normalized)
    normalized = _WINDOWS_PATH_RE.sub("[path removed]", normalized)
    normalized = _LONG_HEX_RE.sub("[identifier removed]", normalized)
    normalized = " ".join(normalized.split()).strip()
    if not normalized:
        normalized = "Unspecified operational error"
    return normalized[:maximum]


def _canonical_operational_report(payload: dict[str, Any]) -> str:
    return json.dumps(
        [
            OPERATIONAL_ERROR_SCHEMA,
            OPERATIONAL_ERROR_NOTICE_VERSION,
            payload["source_instance_sha256"],
            payload["event_id"],
            payload["model_id"],
            payload["pipeline_id"],
            payload["error_code"],
            payload["error_message"],
            payload["stage"],
            payload["runtime"],
            payload["plugin_version"],
            payload["backend_version"],
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


class Krea2OperationalErrorReporter:
    """Submit mandatory, privacy-minimal product errors without user content."""

    def __init__(
        self,
        vision_token: str,
        *,
        endpoint: str = DIAGNOSTIC_ENDPOINT,
        http: Any = requests,
        timeout_seconds: float = 8.0,
        attempts: int = 2,
    ):
        token = str(vision_token or "")
        if len(token.encode("utf-8")) < 32:
            raise ValueError("A configured Vision token is required for operational provenance.")
        if endpoint != DIAGNOSTIC_ENDPOINT:
            raise ValueError("Operational errors are restricted to the canonical Seedframe endpoint.")
        self.endpoint = endpoint
        self.http = http
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 15.0))
        self.attempts = max(1, min(int(attempts), 2))
        self.source_instance_sha256 = hashlib.sha256(
            b"Krea2VisionOperationalSource/v1\0" + token.encode("utf-8")
        ).hexdigest()

    def submit_safely(self, **values) -> bool:
        try:
            self._submit(**values)
            return True
        except Exception as exc:
            log.warning(
                "mandatory privacy-minimal operational error was not accepted event=%s reason=%s",
                values.get("event_id", "untracked"),
                type(exc).__name__,
            )
            return False

    def _submit(
        self,
        *,
        event_id: str,
        model_id: str,
        pipeline_id: str,
        error_code: str,
        error_message: str,
        stage: str,
        runtime: str,
        plugin_version: str,
        backend_version: str,
    ) -> None:
        if not isinstance(event_id, str) or len(event_id) != 32 or any(ch not in "0123456789abcdef" for ch in event_id):
            raise ValueError("Operational event ID is invalid.")
        payload = {
            "schema": OPERATIONAL_ERROR_SCHEMA,
            "notice_version": OPERATIONAL_ERROR_NOTICE_VERSION,
            "source_instance_sha256": self.source_instance_sha256,
            "event_id": event_id,
            "model_id": _clean(model_id or "unknown", 200),
            "pipeline_id": _clean(pipeline_id or "unknown", 200),
            "error_code": _clean(error_code or "operational_error", 80),
            "error_message": sanitize_operational_error(error_message),
            "stage": sanitize_operational_error(stage, 200),
            "runtime": _clean(runtime or "unknown", 40),
            "plugin_version": _clean(plugin_version or "unknown", 40),
            "backend_version": _clean(backend_version or "unknown", 40),
        }
        payload["report_sha256"] = hashlib.sha256(
            _canonical_operational_report(payload).encode("utf-8")
        ).hexdigest()
        headers = {
            "Accept": "application/json",
            "User-Agent": DIAGNOSTIC_USER_AGENT,
            "X-Krea2-Diagnostic-Contract": OPERATIONAL_ERROR_SCHEMA,
            "X-Krea2-Diagnostic-Notice": OPERATIONAL_ERROR_NOTICE_VERSION,
        }
        last_error: Exception | None = None
        for attempt in range(self.attempts):
            try:
                response = self.http.post(
                    self.endpoint,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout_seconds,
                    allow_redirects=False,
                )
                if response.status_code == 200:
                    receipt = response.json()
                    if (
                        isinstance(receipt, dict)
                        and receipt.get("accepted") is True
                        and receipt.get("report_sha256") == payload["report_sha256"]
                    ):
                        return
                    raise RuntimeError("Seedframe returned an invalid operational-error receipt.")
                if response.status_code != 429 and response.status_code < 500:
                    raise RuntimeError(f"Seedframe operational error returned HTTP {response.status_code}.")
                last_error = RuntimeError(f"Seedframe operational error returned HTTP {response.status_code}.")
            except (requests.RequestException, ValueError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
                last_error = exc
                if isinstance(exc, RuntimeError) and "HTTP 4" in str(exc) and "429" not in str(exc):
                    break
            if attempt + 1 < self.attempts:
                time.sleep(0.25 * (attempt + 1))
        raise RuntimeError("Seedframe operational error upload failed.") from last_error


class Krea2DiagnosticReporter:
    """Submit separately consented failure evidence without affecting Vision."""

    def __init__(
        self,
        vision_token: str,
        *,
        endpoint: str = DIAGNOSTIC_ENDPOINT,
        http: Any = requests,
        timeout_seconds: float = 8.0,
        attempts: int = 2,
    ):
        token = str(vision_token or "")
        if len(token.encode("utf-8")) < 32:
            raise ValueError("A configured Vision token is required for diagnostic provenance.")
        if endpoint != DIAGNOSTIC_ENDPOINT:
            raise ValueError("Diagnostics are restricted to the canonical Seedframe endpoint.")
        self.endpoint = endpoint
        self.http = http
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 15.0))
        self.attempts = max(1, min(int(attempts), 2))
        self.source_instance_sha256 = hashlib.sha256(
            b"Krea2VisionDiagnosticSource/v1\0" + token.encode("utf-8")
        ).hexdigest()

    def submit_safely(
        self,
        *,
        image_bytes: bytes,
        job_id: str,
        discord_username: str,
        model_id: str,
        pipeline_id: str,
        error_code: str,
        error_message: str,
        stage: str,
        prompt_text: str | None,
        plugin_version: str,
        backend_version: str,
    ) -> bool:
        try:
            self._submit(
                image_bytes=image_bytes,
                job_id=job_id,
                discord_username=discord_username,
                model_id=model_id,
                pipeline_id=pipeline_id,
                error_code=error_code,
                error_message=error_message,
                stage=stage,
                prompt_text=prompt_text,
                plugin_version=plugin_version,
                backend_version=backend_version,
            )
            return True
        except Exception as exc:
            log.warning(
                "optional Seedframe failure diagnostic was not accepted job=%s model=%s reason=%s",
                job_id,
                model_id,
                type(exc).__name__,
            )
            return False

    def _submit(
        self,
        *,
        image_bytes: bytes,
        job_id: str,
        discord_username: str,
        model_id: str,
        pipeline_id: str,
        error_code: str,
        error_message: str,
        stage: str,
        prompt_text: str | None,
        plugin_version: str,
        backend_version: str,
    ) -> None:
        if not isinstance(image_bytes, bytes) or not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise ValueError("Diagnostic image is missing or too large.")
        if not isinstance(job_id, str) or len(job_id) != 32 or any(ch not in "0123456789abcdef" for ch in job_id):
            raise ValueError("Diagnostic job ID is invalid.")
        prompt = None
        if prompt_text:
            prompt = unicodedata.normalize("NFKC", str(prompt_text)).strip()
            if not prompt or len(prompt) > 50_000:
                raise ValueError("Diagnostic prompt is invalid.")
        image_sha256 = hashlib.sha256(image_bytes).hexdigest()
        payload = {
            "schema": DIAGNOSTIC_SCHEMA,
            "terms_version": DIAGNOSTIC_TERMS_VERSION,
            "terms_accepted": True,
            "source_instance_sha256": self.source_instance_sha256,
            "job_id": job_id,
            "discord_username": _clean(discord_username, 80),
            "model_id": _clean(model_id, 200),
            "pipeline_id": _clean(pipeline_id, 200),
            "error_code": _clean(error_code, 80),
            "error_message": _clean(error_message, 2000),
            "stage": _clean(stage, 200),
            "prompt_text": prompt,
            "image_sha256": image_sha256,
            "plugin_version": _clean(plugin_version, 40),
            "backend_version": _clean(backend_version, 40),
        }
        report_sha256 = hashlib.sha256(_canonical_report(payload).encode("utf-8")).hexdigest()
        payload["report_sha256"] = report_sha256
        metadata = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        headers = {
            "Accept": "application/json",
            "User-Agent": DIAGNOSTIC_USER_AGENT,
            "X-Krea2-Diagnostic-Contract": DIAGNOSTIC_SCHEMA,
            "X-Krea2-Diagnostic-Terms": DIAGNOSTIC_TERMS_VERSION,
        }
        last_error: Exception | None = None
        for attempt in range(self.attempts):
            try:
                response = self.http.post(
                    self.endpoint,
                    data={"metadata": metadata},
                    files={"image": ("vision-failure.jpg", image_bytes, "image/jpeg")},
                    headers=headers,
                    timeout=self.timeout_seconds,
                    allow_redirects=False,
                )
                if response.status_code == 200:
                    receipt = response.json()
                    if (
                        isinstance(receipt, dict)
                        and receipt.get("accepted") is True
                        and receipt.get("report_sha256") == report_sha256
                    ):
                        return
                    raise RuntimeError("Seedframe returned an invalid diagnostic receipt.")
                if response.status_code != 429 and response.status_code < 500:
                    raise RuntimeError(f"Seedframe diagnostic returned HTTP {response.status_code}.")
                last_error = RuntimeError(f"Seedframe diagnostic returned HTTP {response.status_code}.")
            except (requests.RequestException, ValueError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
                last_error = exc
                if isinstance(exc, RuntimeError) and "HTTP 4" in str(exc) and "429" not in str(exc):
                    break
            if attempt + 1 < self.attempts:
                time.sleep(0.25 * (attempt + 1))
        raise RuntimeError("Seedframe diagnostic upload failed.") from last_error

