"""KREA2 remote-Vision gateway: license, audit, and secret-preserving inference."""

from __future__ import annotations

import asyncio
import base64
from decimal import Decimal, InvalidOperation
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import requests
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
try:
    from vastai import CoroutineServerless, VastAI
    from vastai.serverless.client.connection import _make_request as _vast_make_request
except ImportError:  # Allows isolated API-contract tests without the Vast SDK.
    CoroutineServerless = VastAI = _vast_make_request = None

LOGGER = logging.getLogger("krea2.gateway")

MODEL_ID = "gemma4-26b-a4b-heretic-q3-k-l"
PUBLIC_MODEL_ID = "vast::gemma4-26b-a4b-heretic-q3_k_l"
PROMPT_CHAT_MODEL_ID = "heretic-3.8-q4-cloud"
DEDICATED_QWEN_MODEL_ID = "qwen38-27b-heretic-q4-k-m"
DISCORD_ID_RE = re.compile(r"^[1-9][0-9]{16,21}$")
LICENSE_ID_RE = re.compile(r"^lic_[A-Za-z0-9_-]{12,64}$")
REQUEST_ID_RE = re.compile(r"^[a-f0-9]{64}$")
SOURCE_URL_RE = re.compile(r"^https://(?:cdn\.discordapp\.com|media\.discordapp\.net)/attachments/[^\s?#]+(?:\?[^\s]*)?$", re.I)
ENROLLMENT_ID_RE = re.compile(r"^enr_[A-Za-z0-9_-]{24,96}$")
ENROLLMENT_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43,160}$")
OAUTH_STATE_RE = re.compile(r"^[A-Za-z0-9_-]{43,160}$")
OAUTH_ENROLLMENT_TTL_SECONDS = 10 * 60
WELCOME_CREDITS = 60
IMAGE_CREDIT_COST = 3
PROMPT_CHAT_CREDIT_COST = 1
PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT = 350
PROMPT_CHAT_RESULT_TTL_SECONDS = 30 * 60
CREDIT_PACKS: dict[str, dict[str, str | int | bool]] = {
    "intro-1200": {
        "credits": 1200,
        "price_usd": "1.50",
        "one_time": True,
        "label": "One-time starter pack",
    },
    "standard-5": {
        "credits": 2667,
        "price_usd": "5.00",
        "one_time": False,
        "label": "$5 credit pack",
    },
    "standard-10": {
        "credits": 5333,
        "price_usd": "10.00",
        "one_time": False,
        "label": "$10 credit pack",
    },
    "standard-20": {
        "credits": 10667,
        "price_usd": "20.00",
        "one_time": False,
        "label": "$20 credit pack",
    },
}
INTRO_CREDIT_PACK_ID = "intro-1200"
CREDIT_PACK_CREDITS = int(CREDIT_PACKS[INTRO_CREDIT_PACK_ID]["credits"])
CREDIT_PACK_PRICE_USD = str(CREDIT_PACKS[INTRO_CREDIT_PACK_ID]["price_usd"])
CREDIT_RESERVATION_TTL_SECONDS = 2 * 60 * 60
DEFAULT_ALLOWED_GPU_NAMES = ("RTX 3090", "RTX 3090 Ti", "RTX 4090")


def configured_allowed_gpu_names(raw: str | None) -> tuple[str, ...]:
    """Apply the permanent GPU allow-list even when environment data is stale."""

    if raw is None:
        return DEFAULT_ALLOWED_GPU_NAMES
    requested = {item.strip() for item in raw.split(",") if item.strip()}
    return tuple(name for name in DEFAULT_ALLOWED_GPU_NAMES if name in requested)


@dataclass(frozen=True)
class Config:
    database: Path
    vast_endpoint: str
    vast_api_key: str
    audit_webhook_url: str
    admin_key: str
    request_timeout_seconds: float
    max_request_bytes: int
    retention_days: int
    discord_client_id: str
    discord_client_secret: str
    discord_redirect_uri: str
    license_signing_key: str
    btcpay_url: str = ""
    btcpay_store_id: str = ""
    btcpay_api_key: str = ""
    btcpay_webhook_secret: str = ""
    bootstrap_deadline_seconds: float = 600.0
    activation_deadline_seconds: float = 120.0
    inference_deadline_seconds: float = 90.0
    allowed_gpu_names: tuple[str, ...] = DEFAULT_ALLOWED_GPU_NAMES
    max_worker_hourly_usd: float = 0.30
    prompt_chat_endpoint: str = ""
    prompt_chat_api_key: str = ""
    prompt_chat_timeout_seconds: float = 300.0
    dedicated_base_url: str = ""
    dedicated_api_key: str = ""
    openwebui_bridge_api_key: str = ""

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            database=Path(os.getenv("KREA2_GATEWAY_DB", "/data/krea2-vision-gateway/krea2-vision.sqlite3")),
            vast_endpoint=os.getenv("KREA2_GATEWAY_VAST_ENDPOINT", "").strip(),
            vast_api_key=os.getenv("KREA2_GATEWAY_VAST_API_KEY", ""),
            audit_webhook_url=os.getenv("KREA2_GATEWAY_AUDIT_WEBHOOK_URL", "").strip(),
            admin_key=os.getenv("KREA2_GATEWAY_ADMIN_KEY", ""),
            request_timeout_seconds=max(30.0, min(float(os.getenv("KREA2_GATEWAY_TIMEOUT_SECONDS", "1200")), 3600.0)),
            max_request_bytes=max(1_000_000, min(int(os.getenv("KREA2_GATEWAY_MAX_REQUEST_BYTES", str(32 * 1024 * 1024))), 32 * 1024 * 1024)),
            retention_days=max(1, min(int(os.getenv("KREA2_GATEWAY_AUDIT_RETENTION_DAYS", "30")), 365)),
            discord_client_id=os.getenv("KREA2_GATEWAY_DISCORD_CLIENT_ID", "").strip(),
            discord_client_secret=os.getenv("KREA2_GATEWAY_DISCORD_CLIENT_SECRET", ""),
            discord_redirect_uri=os.getenv("KREA2_GATEWAY_DISCORD_REDIRECT_URI", "").strip(),
            license_signing_key=os.getenv("KREA2_GATEWAY_LICENSE_SIGNING_KEY", ""),
            btcpay_url=os.getenv("KREA2_GATEWAY_BTCPAY_URL", "").strip().rstrip("/"),
            btcpay_store_id=os.getenv("KREA2_GATEWAY_BTCPAY_STORE_ID", "").strip(),
            btcpay_api_key=os.getenv("KREA2_GATEWAY_BTCPAY_API_KEY", ""),
            btcpay_webhook_secret=os.getenv("KREA2_GATEWAY_BTCPAY_WEBHOOK_SECRET", ""),
            bootstrap_deadline_seconds=max(
                300.0,
                min(float(os.getenv("KREA2_GATEWAY_BOOTSTRAP_DEADLINE_SECONDS", "600")), 1800.0),
            ),
            activation_deadline_seconds=max(
                30.0,
                min(float(os.getenv("KREA2_GATEWAY_ACTIVATION_DEADLINE_SECONDS", "120")), 120.0),
            ),
            inference_deadline_seconds=max(
                45.0,
                min(float(os.getenv("KREA2_GATEWAY_INFERENCE_DEADLINE_SECONDS", "90")), 180.0),
            ),
            allowed_gpu_names=configured_allowed_gpu_names(
                os.getenv("KREA2_GATEWAY_ALLOWED_GPU_NAMES")
            ),
            max_worker_hourly_usd=max(
                0.10,
                min(float(os.getenv("KREA2_GATEWAY_MAX_WORKER_HOURLY_USD", "0.30")), 0.30),
            ),
            prompt_chat_endpoint=os.getenv("KREA2_GATEWAY_QWEN_ENDPOINT", "").strip(),
            # This worker-group credential has narrower privileges than the
            # Vast management key. Never fall back: the route key is forwarded
            # to both the autoscaler and worker authentication transport.
            prompt_chat_api_key=os.getenv(
                "KREA2_GATEWAY_QWEN_API_KEY", ""
            ).strip(),
            prompt_chat_timeout_seconds=max(
                60.0,
                min(float(os.getenv("KREA2_GATEWAY_QWEN_TIMEOUT_SECONDS", "300")), 900.0),
            ),
            dedicated_base_url=os.getenv(
                "KREA2_GATEWAY_DEDICATED_BASE_URL", ""
            ).strip().rstrip("/"),
            dedicated_api_key=os.getenv(
                "KREA2_GATEWAY_DEDICATED_API_KEY", ""
            ).strip(),
            openwebui_bridge_api_key=os.getenv(
                "KREA2_GATEWAY_OPENWEBUI_BRIDGE_API_KEY",
                os.getenv("KREA2_GATEWAY_DEDICATED_API_KEY", ""),
            ).strip(),
        )


class OAuthStartRequest(BaseModel):
    installation_id: str = Field(min_length=24, max_length=128)
    enrollment_id: str = Field(min_length=28, max_length=100)
    enrollment_secret: str = Field(min_length=43, max_length=160)


class ChatRequest(BaseModel):
    model: str
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=8)
    temperature: float = Field(ge=0, le=2)
    max_tokens: int = Field(ge=1, le=2048)
    stream: bool = False
    response_format: dict[str, Any] | None = None


class PromptChatMessage(BaseModel):
    role: str = Field(min_length=4, max_length=9)
    content: str = Field(min_length=1, max_length=24000)


class PromptChatRequest(BaseModel):
    model: str = PROMPT_CHAT_MODEL_ID
    messages: list[PromptChatMessage] = Field(min_length=1, max_length=16)
    temperature: float = Field(default=0.35, ge=0, le=1)
    max_tokens: int = Field(default=1536, ge=64, le=4096)
    stream: bool = False


class AuditCompletion(BaseModel):
    model_id: str
    prompt_variants: list[str] = Field(min_length=1, max_length=3)
    source_url: str = ""


class DiscordErrorReport(BaseModel):
    event_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    model_id: str = Field(pattern=r"^[A-Za-z0-9:._-]{1,200}$")
    pipeline_id: str = Field(pattern=r"^[A-Za-z0-9:._-]{1,200}$")
    error_code: str = Field(pattern=r"^[A-Za-z0-9._-]{1,80}$")
    error_message: str = Field(min_length=1, max_length=2000)
    stage: str = Field(min_length=1, max_length=200)
    runtime: str = Field(pattern=r"^(?:local|remote|unknown)$")
    plugin_version: str = Field(pattern=r"^[A-Za-z0-9._+-]{1,40}$")
    backend_version: str = Field(pattern=r"^[A-Za-z0-9._+-]{1,40}$")
    technical_trace: str = Field(default="No traceback was supplied.", max_length=131072)


class RevokeRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=240)


class CreditPurchaseRequest(BaseModel):
    """An authenticated request for one server-advertised credit pack."""
    pack_id: str = Field(default="", pattern=r"^[a-z0-9-]{0,40}$")
    confirmation: str = Field(default="", max_length=80)


def clean_text(value: object, maximum: int) -> str:
    return " ".join(str(value or "").split())[:maximum]


_ERROR_CREDENTIAL_RE = re.compile(
    r"(?i)\b(?:token|secret|password|authorization|api[_ -]?key|license[_ -]?token)\s*[:=]\s*[^\s,;]+"
)
_ERROR_AUTH_RE = re.compile(r"(?i)(?:Bearer|Krea2License)\s+[A-Za-z0-9._~+/=-]+")
_ERROR_URL_RE = re.compile(r"https?://[^\s\]\[)>(\"']+")
_ERROR_WINDOWS_PATH_RE = re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\r\n]+")
_ERROR_DATA_RE = re.compile(r"data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+", re.I)
_ERROR_CONTENT_FIELD_RE = re.compile(
    r"(?im)\b(?:prompt|prompt_text|model_output|response_content|image_bytes|image_data)\s*[:=]\s*[^\r\n]+"
)
_ERROR_IMAGE_FILENAME_RE = re.compile(r"(?i)\b[^\s/\\]+\.(?:png|jpe?g|webp|gif|bmp|avif)\b")
_ERROR_LONG_BLOB_RE = re.compile(r"\b[A-Za-z0-9+/=_-]{96,}\b")
_ERROR_DISCORD_ID_RE = re.compile(r"\b[1-9][0-9]{16,21}\b")
_ERROR_LICENSE_RE = re.compile(r"\blic_[A-Za-z0-9_-]{12,64}\b")


def redact_error_report_text(value: object, maximum: int = 131072) -> str:
    """Preserve the exception chain while removing user content and credentials."""

    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = _ERROR_DATA_RE.sub("[image data removed]", text)
    text = _ERROR_CONTENT_FIELD_RE.sub("[generated content removed]", text)
    text = _ERROR_AUTH_RE.sub("[authorization removed]", text)
    text = _ERROR_CREDENTIAL_RE.sub("[credential removed]", text)
    text = _ERROR_URL_RE.sub("[URL removed]", text)
    text = _ERROR_WINDOWS_PATH_RE.sub("[local path removed]", text)
    text = _ERROR_IMAGE_FILENAME_RE.sub("[image filename removed]", text)
    text = _ERROR_LICENSE_RE.sub("[license removed]", text)
    text = _ERROR_DISCORD_ID_RE.sub("[Discord ID removed]", text)
    text = _ERROR_LONG_BLOB_RE.sub("[opaque data removed]", text)
    text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    return (text or "No traceback was supplied.")[:maximum]


def token_hash(salt: str, token: str) -> str:
    return hashlib.sha256((salt + "\0" + token).encode("utf-8")).hexdigest()


def deterministic_license_token(signing_key: str, license_id: str, enrollment_id: str) -> str:
    """Return an opaque bearer token without persisting it in the gateway database."""
    digest = hmac.new(
        signing_key.encode("utf-8"),
        f"krea2-remote-license/v1\0{license_id}\0{enrollment_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def parse_bearer(value: str | None) -> tuple[str, str]:
    prefix = "Krea2License "
    raw = str(value or "")
    if not raw.startswith(prefix):
        raise HTTPException(401, "A remote KREA2 license is required.")
    try:
        license_id, token = raw[len(prefix):].split(".", 1)
    except ValueError as exc:
        raise HTTPException(401, "The remote KREA2 license is malformed.") from exc
    if not LICENSE_ID_RE.fullmatch(license_id) or not (43 <= len(token) <= 160):
        raise HTTPException(401, "The remote KREA2 license is malformed.")
    return license_id, token


class Gateway:
    def __init__(self, config: Config, *, http: Any = requests):
        self.config, self.http = config, http
        self._instance_readiness_until = 0.0
        self._instance_readiness: tuple[int, int] = (0, 0)
        self._instance_ready_ids: set[int] = set()
        self._instance_inspection_succeeded = False
        self._instance_health: dict[str, int] = {
            "starting": 0,
            "unhealthy": 0,
            "inactive": 0,
            "disallowed": 0,
        }
        self._recovery_lock = threading.Lock()
        self._controller_mutation_lock = threading.RLock()
        self._desired_activation_floor = 0.0
        self._desired_prompt_chat_activation_floor = 0.0
        self._activation_headroom_target = 0
        self._activation_evidence_lock = threading.Lock()
        self._activation_failures: dict[int, dict[str, float]] = {}
        self._activation_phase = "idle"
        self._activation_started_at = 0.0
        self._activation_last_elapsed_seconds = 0.0
        self._activation_last_outcome = "none"
        self._recovery_until = 0.0
        self._recovery_status = "idle"
        self._activation_lock = asyncio.Lock()
        self._prompt_chat_lock = asyncio.Lock()
        # Vision, Prompt Editor, and OpenWebUI share one physical GPU. This
        # single FIFO lock prevents overlapping model loads and lets llama.cpp
        # router mode keep exactly one model resident in VRAM.
        self._dedicated_inference_lock = asyncio.Lock()
        self._dedicated_queue_depth = 0
        # Prompt Editor inference can outlive Cloudflare's synchronous request
        # window during a cold start. Keep only transient in-memory job state;
        # prompt text and replies are never persisted to SQLite.
        self._prompt_chat_runs: dict[str, dict[str, Any]] = {}
        self._credit_purchase_lock = threading.Lock()
        self._error_report_lock = threading.Lock()
        self._error_report_seen: dict[str, float] = {}
        self._error_report_rate: dict[str, list[float]] = {}
        config.database.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def dedicated_configured(self) -> bool:
        return bool(
            self.config.dedicated_base_url
            and len(self.config.dedicated_api_key) >= 24
        )

    def _dedicated_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.dedicated_api_key}",
            "Content-Type": "application/json",
        }

    async def _dedicated_completion(
        self,
        payload: dict[str, Any],
        *,
        model: str,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if not self.dedicated_configured():
            raise RuntimeError("Dedicated GPU is not configured")
        request_payload = dict(payload)
        request_payload["model"] = model
        request_payload["stream"] = False

        def request_completion() -> dict[str, Any]:
            response = self.http.post(
                f"{self.config.dedicated_base_url}/v1/chat/completions",
                headers=self._dedicated_headers(),
                json=request_payload,
                timeout=timeout_seconds,
            )
            status = int(getattr(response, "status_code", 500))
            try:
                document = response.json()
            except Exception as exc:
                raise RuntimeError(
                    f"Dedicated GPU returned invalid JSON (HTTP {status})"
                ) from exc
            if status >= 400:
                detail = document.get("error") if isinstance(document, dict) else None
                raise RuntimeError(
                    f"Dedicated GPU request failed (HTTP {status}): {str(detail or 'unknown error')[:300]}"
                )
            if not isinstance(document, dict):
                raise RuntimeError("Dedicated GPU returned a non-object response")
            choices = document.get("choices")
            if not isinstance(choices, list) or not choices:
                raise RuntimeError("Dedicated GPU returned no completion choices")
            return document

        self._dedicated_queue_depth += 1
        try:
            async with self._dedicated_inference_lock:
                return await asyncio.to_thread(request_completion)
        finally:
            self._dedicated_queue_depth = max(0, self._dedicated_queue_depth - 1)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.config.database)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _initialize(self) -> None:
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS licenses (
                    license_id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL,
                    discord_username TEXT NOT NULL, installation_digest TEXT NOT NULL,
                    token_salt TEXT NOT NULL, token_digest TEXT NOT NULL,
                    auth_method TEXT NOT NULL DEFAULT 'legacy_claim',
                    status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),
                    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
                    revoked_at INTEGER, revoked_reason TEXT
                );
                CREATE INDEX IF NOT EXISTS licenses_user_idx ON licenses(discord_user_id);
                CREATE TABLE IF NOT EXISTS oauth_enrollments (
                    enrollment_id TEXT PRIMARY KEY, enrollment_salt TEXT NOT NULL,
                    enrollment_digest TEXT NOT NULL, installation_digest TEXT NOT NULL,
                    state TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','complete','denied','expired')),
                    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                    completed_at INTEGER, delivered_at INTEGER, discord_user_id TEXT,
                    discord_username TEXT, license_id TEXT
                );
                CREATE INDEX IF NOT EXISTS oauth_enrollments_expiry_idx ON oauth_enrollments(expires_at);
                CREATE TABLE IF NOT EXISTS remote_jobs (
                    request_id TEXT PRIMARY KEY, license_id TEXT NOT NULL, model_id TEXT NOT NULL,
                    discord_user_id TEXT NOT NULL, discord_username TEXT NOT NULL,
                    started_at INTEGER NOT NULL, completed_at INTEGER, calls INTEGER NOT NULL DEFAULT 0,
                    source_url TEXT, prompt_variants_json TEXT
                );
                CREATE INDEX IF NOT EXISTS remote_jobs_retention_idx ON remote_jobs(completed_at);
                CREATE TABLE IF NOT EXISTS credit_accounts (
                    discord_user_id TEXT PRIMARY KEY, available_credits INTEGER NOT NULL CHECK(available_credits >= 0),
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS credit_ledger (
                    entry_id INTEGER PRIMARY KEY AUTOINCREMENT, discord_user_id TEXT NOT NULL,
                    delta_credits INTEGER NOT NULL, entry_kind TEXT NOT NULL,
                    request_id TEXT, invoice_id TEXT, idempotency_key TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger(discord_user_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS credit_invoices (
                    invoice_id TEXT PRIMARY KEY, purchase_reference TEXT NOT NULL UNIQUE,
                    discord_user_id TEXT NOT NULL, license_id TEXT NOT NULL,
                    pack_id TEXT NOT NULL DEFAULT '',
                    credits INTEGER NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL,
                    checkout_url TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('new','settled','expired','invalid')),
                    created_at INTEGER NOT NULL, settled_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS btcpay_webhook_deliveries (
                    delivery_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS prompt_chat_jobs (
                    request_id TEXT PRIMARY KEY, license_id TEXT NOT NULL,
                    discord_user_id TEXT NOT NULL, model_id TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    credit_state TEXT NOT NULL CHECK(credit_state IN ('reserved','charged','refunded')),
                    started_at INTEGER NOT NULL, completed_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS prompt_chat_jobs_retention_idx
                    ON prompt_chat_jobs(completed_at);
            """)

            columns = {row[1] for row in db.execute("PRAGMA table_info(licenses)")}
            if "auth_method" not in columns:
                db.execute("ALTER TABLE licenses ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy_claim'")
            job_columns = {row[1] for row in db.execute("PRAGMA table_info(remote_jobs)")}
            if "credit_state" not in job_columns:
                db.execute("ALTER TABLE remote_jobs ADD COLUMN credit_state TEXT NOT NULL DEFAULT 'none'")
            if "request_digest" not in job_columns:
                db.execute("ALTER TABLE remote_jobs ADD COLUMN request_digest TEXT")
            invoice_columns = {row[1] for row in db.execute("PRAGMA table_info(credit_invoices)")}
            if "pack_id" not in invoice_columns:
                db.execute("ALTER TABLE credit_invoices ADD COLUMN pack_id TEXT NOT NULL DEFAULT ''")
            # Invoices created before selectable packs existed were all the
            # one-time $1.50 / 1,200-credit offer. Preserve that provenance so
            # an account can never settle several legacy starter invoices.
            db.execute(
                "UPDATE credit_invoices SET pack_id=? WHERE pack_id='' AND credits=? AND amount=? AND currency='USD'",
                (INTRO_CREDIT_PACK_ID, CREDIT_PACK_CREDITS, CREDIT_PACK_PRICE_USD),
            )

    def oauth_configured(self) -> bool:
        return bool(
            re.fullmatch(r"[0-9]{17,22}", self.config.discord_client_id)
            and len(self.config.discord_client_secret) >= 24
            and self.config.discord_redirect_uri.startswith("https://")
            and len(self.config.license_signing_key) >= 32
        )

    def btcpay_configured(self) -> bool:
        return bool(
            self.config.btcpay_url.startswith("https://")
            and len(self.config.btcpay_store_id) >= 6
            and len(self.config.btcpay_api_key) >= 24
            and len(self.config.btcpay_webhook_secret) >= 32
        )

    async def _actual_instance_readiness(self, endpoint_id: int) -> tuple[int, int]:
        """Fallback for Vast's stale Serverless worker-list endpoint."""
        now = time.monotonic()
        if now < self._instance_readiness_until:
            return self._instance_readiness
        if VastAI is None:
            self._instance_inspection_succeeded = False
            self._instance_ready_ids = set()
            return 0, 0

        def inspect() -> tuple[int, int, int, int, int, int, set[int]]:
            client = VastAI(api_key=self.config.vast_api_key)
            prefix = f"{self.config.vast_endpoint}:{endpoint_id}:"
            group = next(
                item
                for item in client.show_workergroups()
                if int(item.get("endpoint_id") or 0) == endpoint_id
            )
            machine_filter = (group.get("search_query") or {}).get("machine_id") or {}
            excluded_machines = set(int(value) for value in machine_filter.get("notin", []))
            if "neq" in machine_filter:
                excluded_machines.add(int(machine_filter["neq"]))
            instances = [
                item for item in client.show_instances()
                if str(item.get("label", "")).startswith(prefix)
                and str(item.get("actual_status", "")).casefold() in {"loading", "running", "exited"}
                and str(item.get("cur_state", "")).casefold() in {"running", "stopped"}
            ]
            ready = 0
            ready_ids: set[int] = set()
            starting = 0
            unhealthy = 0
            inactive = 0
            disallowed = 0
            allowed_instances = 0
            wall_now = time.time()
            for item in instances:
                # Machines in the workergroup's explicit deny-list have already
                # been quarantined and are no longer admission candidates. Vast
                # can retain their stopped Serverless instance rows for hours;
                # counting those historical rows as live policy violations
                # makes an otherwise healthy replacement cold pool ineligible.
                if int(item.get("machine_id") or 0) in excluded_machines:
                    continue
                gpu_name = str(item.get("gpu_name") or "").strip()
                try:
                    hourly_usd = float(item.get("dph_total") or 0)
                except (TypeError, ValueError):
                    hourly_usd = self.config.max_worker_hourly_usd + 1
                if (
                    gpu_name not in self.config.allowed_gpu_names
                    or hourly_usd <= 0
                    or hourly_usd > self.config.max_worker_hourly_usd
                ):
                    disallowed += 1
                    continue
                allowed_instances += 1
                model_ready = False
                if str(item.get("actual_status", "")).casefold() in {"running", "exited"}:
                    logs = client.logs(int(item["id"]), tail="2000") or ""
                    if "KREA2_MODEL_READY" in logs:
                        model_ready = True
                if model_ready:
                    if str(item.get("cur_state", "")).casefold() == "stopped":
                        inactive += 1
                    else:
                        ready += 1
                        ready_ids.add(int(item.get("id") or 0))
                    continue
                start_date = float(item.get("start_date") or wall_now)
                if wall_now - start_date >= self.config.bootstrap_deadline_seconds:
                    unhealthy += 1
                else:
                    starting += 1
            ready_ids.discard(0)
            return allowed_instances, ready, starting, unhealthy, inactive, disallowed, ready_ids

        try:
            result = await asyncio.to_thread(inspect)
            self._instance_readiness = result[:2]
            self._instance_ready_ids = set(result[6])
            self._instance_inspection_succeeded = True
            self._instance_health = {
                "starting": result[2],
                "unhealthy": result[3],
                "inactive": result[4],
                "disallowed": result[5],
            }
        except Exception:
            self._instance_readiness = (0, 0)
            self._instance_ready_ids = set()
            self._instance_inspection_succeeded = False
            self._instance_health = {
                "starting": 0,
                "unhealthy": 0,
                "inactive": 0,
                "disallowed": 0,
            }
        self._instance_readiness_until = time.monotonic() + 15.0
        return self._instance_readiness

    @staticmethod
    def _update_workergroup(client: Any, group: dict[str, Any], search_query: dict[str, Any]) -> None:
        response = client.client.put(
            f"/autojobs/{int(group['id'])}/",
            json_data={
                "client_id": "me",
                "autojob_id": int(group["id"]),
                "min_load": float(group.get("min_load") or 0),
                "target_util": float(group.get("target_util") or 0.9),
                "cold_mult": float(group.get("cold_mult") or 1),
                "cold_workers": int(group.get("cold_workers") or 1),
                "test_workers": group.get("test_workers"),
                "template_hash": group.get("template_hash"),
                "template_id": group.get("template_id"),
                "search_params": search_query,
                "launch_args": group.get("launch_args") or "",
                "gpu_ram": float(group.get("gpu_ram") or 24),
                "endpoint_name": group.get("endpoint_name"),
                "endpoint_id": int(group["endpoint_id"]),
            },
        )
        response.raise_for_status()

    @staticmethod
    def _update_endpoint_cold_workers(client: Any, endpoint: dict[str, Any], cold_workers: int) -> None:
        Gateway._update_endpoint_runtime(
            client,
            endpoint,
            min_load=float(endpoint.get("min_load") or 0),
            cold_workers=cold_workers,
            max_workers=int(endpoint.get("max_workers") or 5),
        )

    @staticmethod
    def _update_endpoint_runtime(
        client: Any,
        endpoint: dict[str, Any],
        *,
        min_load: float,
        cold_workers: int = 1,
        max_workers: int = 5,
    ) -> None:
        response = client.client.put(
            f"/endptjobs/{int(endpoint['id'])}/",
            json_data={
                "client_id": "me",
                "endptjob_id": int(endpoint["id"]),
                "min_load": float(min_load),
                "min_cold_load": float(endpoint.get("min_cold_load") or 0),
                "target_util": float(endpoint.get("target_util") or 0.9),
                "cold_mult": float(endpoint.get("cold_mult") or 1),
                "cold_workers": cold_workers,
                "max_workers": max_workers,
                "endpoint_name": endpoint.get("endpoint_name"),
                "endpoint_state": endpoint.get("endpoint_state") or "active",
                "max_queue_time": float(endpoint.get("max_queue_time") or 30),
                "target_queue_time": float(endpoint.get("target_queue_time") or 10),
                "inactivity_timeout": float(endpoint.get("inactivity_timeout") or 30),
                "autoscaler_instance": endpoint.get("autoscaler_instance"),
            },
        )
        response.raise_for_status()

    def _set_activation_floor(self, min_load: float) -> None:
        with self._controller_mutation_lock:
            self._desired_activation_floor = float(min_load)
            try:
                self._set_activation_floor_locked(min_load)
            except Exception:
                # If a partial floor-up fails, later health reconciliation must
                # converge to scale-to-zero rather than preserve a stale 1.0.
                if float(min_load) > 0:
                    self._desired_activation_floor = 0.0
                raise

    def _set_activation_floor_locked(self, min_load: float) -> None:
        """Temporarily wake one cold worker without leaving a billable floor.

        Vast's scoped Serverless credential cannot start a Serverless-owned
        instance directly.  A tiny positive endpoint floor is the supported
        controller signal.  Every call also restores the required one-cold /
        five-maximum shape, so a single image can never fan out into a fleet.
        """

        if VastAI is None:
            raise RuntimeError("Vast SDK unavailable")
        client = VastAI(api_key=self.config.vast_api_key)
        endpoint = next(
            item
            for item in client.show_endpoints()
            if str(item.get("endpoint_name") or "") == self.config.vast_endpoint
        )
        endpoint_id = int(endpoint.get("id") or 0)
        group = next(
            item
            for item in client.show_workergroups()
            if int(item.get("endpoint_id") or 0) == endpoint_id
        )
        runtime_group = dict(group)
        runtime_group["min_load"] = float(min_load)
        self._update_workergroup(
            client,
            runtime_group,
            dict(group.get("search_query") or {}),
        )
        cold_target = max(1, int(self._activation_headroom_target or 0))
        self._update_endpoint_runtime(
            client,
            endpoint,
            min_load=min_load,
            cold_workers=cold_target,
            max_workers=5,
        )
        # A successful PUT is not enough for the safety boundary: confirm that
        # both controller objects actually expose the requested floor and that
        # the endpoint still has the required one-cold / five-maximum shape.
        for attempt in range(3):
            observed_endpoint = next(
                item
                for item in client.show_endpoints()
                if int(item.get("id") or 0) == endpoint_id
            )
            observed_group = next(
                item
                for item in client.show_workergroups()
                if int(item.get("endpoint_id") or 0) == endpoint_id
            )
            if (
                abs(float(observed_endpoint.get("min_load") or 0) - float(min_load)) < 0.001
                and abs(float(observed_group.get("min_load") or 0) - float(min_load)) < 0.001
                and int(observed_endpoint.get("cold_workers") or 0) == cold_target
                and int(observed_endpoint.get("max_workers") or 0) == 5
            ):
                return
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
        raise RuntimeError("Vast controller did not confirm the requested activation floor")

    async def _set_activation_floor_async(self, min_load: float) -> None:
        """Finish the controller mutation even if the HTTP client disconnects."""

        mutation = asyncio.create_task(asyncio.to_thread(self._set_activation_floor, min_load))
        try:
            await asyncio.shield(mutation)
        except asyncio.CancelledError:
            # Cancelling asyncio.to_thread does not stop its controller PUTs.
            # Wait for that exact mutation before callers restore the floor so
            # a late floor-up cannot race and overwrite a successful reset.
            await mutation
            raise

    async def _restore_activation_floor(self) -> None:
        """Boundedly restore and verify scale-to-zero before credit admission."""

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                await self._set_activation_floor_async(0.0)
                return
            except asyncio.CancelledError:
                # The shielded reset completed before cancellation propagated.
                raise
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(1.0 + attempt)
        raise last_error or RuntimeError("Vast activation floor reset failed")

    def _set_prompt_chat_activation_floor(self, min_load: float) -> None:
        """Wake only the Qwen Prompt Editor endpoint, preserving its pool shape."""

        with self._controller_mutation_lock:
            self._desired_prompt_chat_activation_floor = float(min_load)
            try:
                self._set_prompt_chat_activation_floor_locked(min_load)
            except Exception:
                if float(min_load) > 0:
                    self._desired_prompt_chat_activation_floor = 0.0
                raise

    def _set_prompt_chat_activation_floor_locked(self, min_load: float) -> None:
        if VastAI is None:
            raise RuntimeError("Vast SDK unavailable")
        endpoint_name = self.config.prompt_chat_endpoint
        if not endpoint_name:
            raise RuntimeError("Qwen Prompt Editor endpoint is not configured")
        client = VastAI(api_key=self.config.vast_api_key)
        endpoint = next(
            item
            for item in client.show_endpoints()
            if str(item.get("endpoint_name") or "") == endpoint_name
        )
        endpoint_id = int(endpoint.get("id") or 0)
        group = next(
            item
            for item in client.show_workergroups()
            if int(item.get("endpoint_id") or 0) == endpoint_id
        )
        runtime_group = dict(group)
        runtime_group["min_load"] = float(min_load)
        self._update_workergroup(
            client,
            runtime_group,
            dict(group.get("search_query") or {}),
        )
        cold_workers = max(1, int(endpoint.get("cold_workers") or 0))
        max_workers = max(cold_workers, int(endpoint.get("max_workers") or 0), 1)
        self._update_endpoint_runtime(
            client,
            endpoint,
            min_load=float(min_load),
            cold_workers=cold_workers,
            max_workers=max_workers,
        )
        for attempt in range(3):
            observed_endpoint = next(
                item
                for item in client.show_endpoints()
                if int(item.get("id") or 0) == endpoint_id
            )
            observed_group = next(
                item
                for item in client.show_workergroups()
                if int(item.get("endpoint_id") or 0) == endpoint_id
            )
            if (
                abs(float(observed_endpoint.get("min_load") or 0) - float(min_load)) < 0.001
                and abs(float(observed_group.get("min_load") or 0) - float(min_load)) < 0.001
                and int(observed_endpoint.get("cold_workers") or 0) == cold_workers
                and int(observed_endpoint.get("max_workers") or 0) == max_workers
            ):
                return
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
        raise RuntimeError("Qwen controller did not confirm the requested activation floor")

    async def _set_prompt_chat_activation_floor_async(self, min_load: float) -> None:
        mutation = asyncio.create_task(
            asyncio.to_thread(self._set_prompt_chat_activation_floor, min_load)
        )
        try:
            await asyncio.shield(mutation)
        except asyncio.CancelledError:
            await mutation
            raise

    async def _restore_prompt_chat_activation_floor(self) -> None:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                await self._set_prompt_chat_activation_floor_async(0.0)
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(1.0 + attempt)
        raise last_error or RuntimeError("Qwen activation floor reset failed")

    @asynccontextmanager
    async def _prompt_chat_activation_guard(self):
        """Always return Qwen to scale-to-zero after a prompt edit attempt."""

        floor_attempted = False
        try:
            floor_attempted = True
            await self._set_prompt_chat_activation_floor_async(1.0)
            yield
        finally:
            if floor_attempted:
                cleanup = asyncio.create_task(
                    self._restore_prompt_chat_activation_floor()
                )
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                    raise

    def _prepared_activation_machine_ids(self) -> set[int]:
        """Return the exact approved stopped workers eligible for this wake.

        Capture this before raising the load floor.  A worker can transition to
        running while a route is pending, so selecting failure candidates only
        after a timeout can either miss the actual standby or quarantine a new
        replacement that appeared during recovery.
        """

        if VastAI is None:
            return set()
        client = VastAI(api_key=self.config.vast_api_key)
        endpoint = next(
            item
            for item in client.show_endpoints()
            if str(item.get("endpoint_name") or "") == self.config.vast_endpoint
        )
        endpoint_id = int(endpoint.get("id") or 0)
        group = next(
            item
            for item in client.show_workergroups()
            if int(item.get("endpoint_id") or 0) == endpoint_id
        )
        prefix = f"{self.config.vast_endpoint}:{endpoint_id}:"
        machine_filter = (group.get("search_query") or {}).get("machine_id") or {}
        excluded = set(int(value) for value in machine_filter.get("notin", []))
        if "neq" in machine_filter:
            excluded.add(int(machine_filter["neq"]))
        prepared: set[int] = set()
        for item in client.show_instances():
            machine_id = int(item.get("machine_id") or 0)
            if (
                not machine_id
                or machine_id in excluded
                or not str(item.get("label") or "").startswith(prefix)
                or str(item.get("cur_state") or "").casefold() != "stopped"
            ):
                continue
            gpu_name = str(item.get("gpu_name") or "").strip()
            try:
                hourly_usd = float(item.get("dph_total") or 0)
            except (TypeError, ValueError):
                continue
            if gpu_name not in self.config.allowed_gpu_names or not (0 < hourly_usd <= self.config.max_worker_hourly_usd):
                continue
            try:
                logs = client.logs(int(item["id"]), tail="2000") or ""
            except Exception:
                logs = ""
            if "KREA2_MODEL_READY" in logs:
                prepared.add(machine_id)
        return prepared

    def _replace_failed_activation_workers(self, failed_machine_ids: set[int] | None = None) -> set[int]:
        with self._controller_mutation_lock:
            return self._replace_failed_activation_workers_locked(failed_machine_ids)

    def _request_activation_recovery_headroom(self, minimum_prepared_workers: int) -> int:
        """Recruit one extra cold standby without accusing an existing GPU."""

        with self._controller_mutation_lock:
            if VastAI is None:
                return 0
            client = VastAI(api_key=self.config.vast_api_key)
            endpoint = next(
                item
                for item in client.show_endpoints()
                if str(item.get("endpoint_name") or "") == self.config.vast_endpoint
            )
            current_cold = max(1, int(endpoint.get("cold_workers") or 0))
            desired_cold = min(5, max(current_cold + 1, minimum_prepared_workers))
            self._desired_activation_floor = 0.0
            self._activation_headroom_target = min(5, max(2, minimum_prepared_workers))
            self._set_activation_floor_locked(0.0)
            endpoint = next(
                item
                for item in client.show_endpoints()
                if str(item.get("endpoint_name") or "") == self.config.vast_endpoint
            )
            self._update_endpoint_runtime(
                client,
                endpoint,
                min_load=0.0,
                cold_workers=desired_cold,
                max_workers=5,
            )
            observed = next(
                item
                for item in client.show_endpoints()
                if int(item.get("id") or 0) == int(endpoint.get("id") or 0)
            )
            if (
                abs(float(observed.get("min_load") or 0)) >= 0.001
                or int(observed.get("cold_workers") or 0) != desired_cold
                or int(observed.get("max_workers") or 0) != 5
            ):
                raise RuntimeError("Vast recovery headroom was not confirmed")
            self._recovery_status = "replacement-recruiting"
            self._recovery_until = 0.0
            self._instance_readiness_until = 0.0
            return desired_cold

    def _cancel_activation_recovery_headroom(self) -> None:
        with self._controller_mutation_lock:
            self._activation_headroom_target = 0
            self._desired_activation_floor = 0.0
            self._set_activation_floor_locked(0.0)

    @asynccontextmanager
    async def _activation_headroom_guard(self):
        """Collapse temporary cold capacity on every return/error/cancel path."""

        try:
            yield
        finally:
            if self._activation_headroom_target:
                cleanup = asyncio.create_task(
                    asyncio.to_thread(self._cancel_activation_recovery_headroom)
                )
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    # The controller mutation must finish before cancellation
                    # escapes or a late cold_workers=1 write can race another
                    # request's floor transition.
                    await cleanup
                    raise

    def _replace_failed_activation_workers_locked(self, failed_machine_ids: set[int] | None = None) -> set[int]:
        """Exclude one unambiguous standby proven by this failed wake.

        Vast routing does not identify a selected machine before READY.  If
        several prepared standbys existed, a route timeout cannot prove which
        one failed, so quarantining the entire pool would be unsafe.
        """

        if VastAI is None:
            return set()
        client = VastAI(api_key=self.config.vast_api_key)
        endpoint = next(
            item
            for item in client.show_endpoints()
            if str(item.get("endpoint_name") or "") == self.config.vast_endpoint
        )
        endpoint_id = int(endpoint.get("id") or 0)
        group = next(
            item
            for item in client.show_workergroups()
            if int(item.get("endpoint_id") or 0) == endpoint_id
        )
        failed_ids = set(failed_machine_ids or ())
        if not failed_ids:
            failed_ids = self._prepared_activation_machine_ids()
        if not failed_ids:
            return set()
        if len(failed_ids) != 1:
            self._recovery_status = "activation-retrying"
            return set()

        query = dict(group.get("search_query") or {})
        machine_filter = query.get("machine_id") or {}
        excluded = set(int(value) for value in machine_filter.get("notin", []))
        if "neq" in machine_filter:
            excluded.add(int(machine_filter["neq"]))
        excluded.update(failed_ids)
        query["machine_id"] = {"notin": sorted(excluded)}
        query["gpu_name"] = {"in": list(self.config.allowed_gpu_names)}
        query["dph_total"] = {"lte": str(self.config.max_worker_hourly_usd)}
        self._update_workergroup(client, group, query)
        self._update_endpoint_runtime(
            client,
            endpoint,
            min_load=0.0,
            cold_workers=min(5, max(2, len(failed_ids) + 1)),
            max_workers=5,
        )
        self._recovery_status = "replacement-recruiting"
        self._activation_headroom_target = 0
        self._recovery_until = 0.0
        self._instance_readiness_until = 0.0
        return failed_ids

    async def _reconcile_unhealthy_workers(self, endpoint_id: int, workergroup_id: int) -> None:
        """Ask the Vast controller for a replacement without charging an image.

        Serverless-owned instances cannot be destroyed with the gateway's
        scoped key.  Instead, exclude failed machines and temporarily raise the
        cold-pool target from one to two.  Once a healthy worker registers, put
        the target back at one so Vast retires the excess failed bootstrap.
        """

        if VastAI is None or time.monotonic() < self._recovery_until:
            return
        if not self._recovery_lock.acquire(blocking=False):
            return

        def reconcile_unlocked() -> str:
            client = VastAI(api_key=self.config.vast_api_key)
            prefix = f"{self.config.vast_endpoint}:{endpoint_id}:"
            wall_now = time.time()
            groups = client.show_workergroups()
            group = next(item for item in groups if int(item.get("id") or 0) == workergroup_id)
            endpoints = client.show_endpoints()
            endpoint = next(item for item in endpoints if int(item.get("id") or 0) == endpoint_id)
            desired_floor = float(self._desired_activation_floor)
            query = dict(group.get("search_query") or {})
            machine_filter = query.get("machine_id") or {}
            excluded_machines = set(int(value) for value in machine_filter.get("notin", []))
            if "neq" in machine_filter:
                excluded_machines.add(int(machine_filter["neq"]))
            active = [
                item for item in client.show_instances()
                if str(item.get("label", "")).startswith(prefix)
                and str(item.get("cur_state", "")).casefold() in {"running", "stopped"}
                and str(item.get("actual_status", "")).casefold() in {"loading", "running", "exited"}
            ]
            ready = []
            stale = []
            disallowed = []
            for item in active:
                gpu_name = str(item.get("gpu_name") or "").strip()
                try:
                    hourly_usd = float(item.get("dph_total") or 0)
                except (TypeError, ValueError):
                    hourly_usd = self.config.max_worker_hourly_usd + 1
                if (
                    int(item.get("machine_id") or 0) in excluded_machines
                    or gpu_name not in self.config.allowed_gpu_names
                    or hourly_usd <= 0
                    or hourly_usd > self.config.max_worker_hourly_usd
                ):
                    disallowed.append(item)
                    continue
                logs = ""
                if str(item.get("actual_status", "")).casefold() in {"running", "exited"}:
                    try:
                        logs = client.logs(int(item["id"]), tail="2000") or ""
                    except Exception:
                        logs = ""
                if "KREA2_MODEL_READY" in logs:
                    ready.append(item)
                elif wall_now - float(item.get("start_date") or wall_now) >= self.config.bootstrap_deadline_seconds:
                    stale.append(item)

            configured_cold = int(endpoint.get("cold_workers") or 0)
            current_cold = max(1, configured_cold)

            changed = abs(float(group.get("min_load") or 0) - desired_floor) >= 0.001
            wanted_gpu_filter = {"in": list(self.config.allowed_gpu_names)}
            if query.get("gpu_name") != wanted_gpu_filter:
                query["gpu_name"] = wanted_gpu_filter
                changed = True
            wanted_price_filter = {"lte": str(self.config.max_worker_hourly_usd)}
            if query.get("dph_total") != wanted_price_filter:
                query["dph_total"] = wanted_price_filter
                changed = True

            bad_instances = [*stale, *disallowed]
            if bad_instances:
                excluded: set[int] = set()
                current_machine_filter = query.get("machine_id")
                if isinstance(current_machine_filter, dict):
                    if "neq" in current_machine_filter:
                        excluded.add(int(current_machine_filter["neq"]))
                    for value in current_machine_filter.get("notin", []):
                        excluded.add(int(value))
                excluded.update(int(item["machine_id"]) for item in bad_instances if item.get("machine_id"))
                wanted_filter = {"notin": sorted(excluded)}
                if query.get("machine_id") != wanted_filter:
                    query["machine_id"] = wanted_filter
                    changed = True

            if changed:
                runtime_group = dict(group)
                runtime_group["min_load"] = desired_floor
                self._update_workergroup(client, runtime_group, query)

            endpoint_policy_mismatch = (
                abs(float(endpoint.get("min_load") or 0) - desired_floor) >= 0.001
                or configured_cold != current_cold
                or int(endpoint.get("max_workers") or 0) != 5
            )

            def finish(status: str, cold_workers: int = current_cold) -> str:
                if endpoint_policy_mismatch or cold_workers != current_cold:
                    self._update_endpoint_runtime(
                        client,
                        endpoint,
                        min_load=desired_floor,
                        cold_workers=cold_workers,
                        max_workers=5,
                    )
                observed_group = next(
                    item
                    for item in client.show_workergroups()
                    if int(item.get("id") or 0) == workergroup_id
                )
                observed_endpoint = next(
                    item
                    for item in client.show_endpoints()
                    if int(item.get("id") or 0) == endpoint_id
                )
                if (
                    abs(float(observed_group.get("min_load") or 0) - desired_floor) >= 0.001
                    or abs(float(observed_endpoint.get("min_load") or 0) - desired_floor) >= 0.001
                    or int(observed_endpoint.get("cold_workers") or 0) != cold_workers
                    or int(observed_endpoint.get("max_workers") or 0) != 5
                ):
                    raise RuntimeError("Vast controller floor reconciliation was not confirmed")
                return status

            if ready:
                if (
                    current_cold > 1
                    and self._activation_headroom_target
                ):
                    return finish("replacement-recruiting")
                if current_cold > 1:
                    self._activation_headroom_target = 0
                    return finish("cold-pool-restored", 1)
                return finish("healthy")

            if bad_instances or not active:
                max_workers = int(endpoint.get("max_workers") or 5)
                desired_cold = min(
                    max_workers,
                    max(2, len(bad_instances) + 1),
                )
                return finish("replacement-recruiting", max(current_cold, desired_cold))

            return finish("waiting")

        def reconcile() -> str:
            with self._controller_mutation_lock:
                return reconcile_unlocked()

        try:
            self._recovery_status = await asyncio.to_thread(reconcile)
        except Exception:
            self._recovery_status = "controller-unavailable"
        finally:
            self._recovery_until = time.monotonic() + 30.0
            self._recovery_lock.release()

    async def remote_readiness(self) -> dict[str, Any]:
        """Return a secret-free snapshot of the actual serverless capacity.

        A configured endpoint is not necessarily a usable endpoint: Vast can
        retain the endpoint settings after a worker group/template disappears.
        Check this before reserving image credits or accepting a long request.
        """
        if self.dedicated_configured():
            def check_dedicated() -> bool:
                response = self.http.get(
                    f"{self.config.dedicated_base_url}/v1/models",
                    headers=self._dedicated_headers(),
                    timeout=5,
                )
                if int(getattr(response, "status_code", 500)) != 200:
                    return False
                document = response.json()
                models = document.get("data") if isinstance(document, dict) else None
                return isinstance(models, list) and bool(models)

            try:
                ready = await asyncio.to_thread(check_dedicated)
            except Exception:
                ready = False
            return {
                "configured": True,
                "sdk_available": True,
                "workergroup_attached": True,
                "controller_verified": True,
                "cold_start_eligible": False,
                "worker_count": 1,
                "ready_workers": 1 if ready else 0,
                "controller_ready_workers": 1 if ready else 0,
                "starting_workers": 0 if ready else 1,
                "unhealthy_workers": 0,
                "inactive_workers": 0,
                "disallowed_workers": 0,
                "recovery_status": "dedicated-ready" if ready else "dedicated-warming",
                "queue_depth": self._dedicated_queue_depth,
                "reason": (
                    "Dedicated RTX 3090 ready."
                    if ready
                    else "Dedicated RTX 3090 is downloading or loading its verified models."
                ),
            }
        configured = bool(self.config.vast_endpoint and len(self.config.vast_api_key) >= 24)
        snapshot: dict[str, Any] = {
            "configured": configured,
            "sdk_available": CoroutineServerless is not None,
            "workergroup_attached": False,
            "controller_verified": False,
            "cold_start_eligible": False,
            "worker_count": 0,
            "ready_workers": 0,
            "controller_ready_workers": 0,
            "reason": "",
        }
        if not configured:
            snapshot["reason"] = "Remote Vision is not configured."
            return snapshot
        if CoroutineServerless is None:
            snapshot["reason"] = "Remote Vision SDK is unavailable."
            return snapshot
        endpoint_id = 0
        workergroup_id = 0
        workers: list[Any] = []
        try:
            async with CoroutineServerless(api_key=self.config.vast_api_key) as client:
                endpoint = await client.get_endpoint(self.config.vast_endpoint)
                endpoint_id = int(endpoint.id)
                workergroup_id = int(await client.find_workergroup_for_endpoint(endpoint_id) or 0)
                snapshot["workergroup_attached"] = bool(workergroup_id)
                if not workergroup_id:
                    snapshot["reason"] = "No serverless worker group is attached."
                    return snapshot
                workers = await endpoint.get_workers()
        except Exception:
            # Vast's routing-status API is occasionally unavailable while its
            # ordinary controller API still has the exact endpoint, group and
            # instance state.  Fall back without weakening GPU/cost policy.
            def controller_ids() -> tuple[int, int]:
                if VastAI is None:
                    return 0, 0
                controller = VastAI(api_key=self.config.vast_api_key)
                endpoint_row = next(
                    item
                    for item in controller.show_endpoints()
                    if str(item.get("endpoint_name") or "") == self.config.vast_endpoint
                )
                found_endpoint_id = int(endpoint_row.get("id") or 0)
                group_row = next(
                    item
                    for item in controller.show_workergroups()
                    if int(item.get("endpoint_id") or 0) == found_endpoint_id
                )
                return found_endpoint_id, int(group_row.get("id") or 0)

            try:
                endpoint_id, workergroup_id = await asyncio.to_thread(controller_ids)
                snapshot["workergroup_attached"] = bool(workergroup_id)
            except Exception:
                snapshot["reason"] = "Remote worker status could not be verified."
                return snapshot
        snapshot["worker_count"] = len(workers)
        ready_states = {"READY", "IDLE", "LOADED", "RUNNING"}
        routing_ready_ids = {
            int(getattr(worker, "id", 0) or 0)
            for worker in workers
            if str(getattr(worker, "status", "")).upper() in ready_states
        }
        routing_ready_ids.discard(0)
        snapshot["ready_workers"] = len(routing_ready_ids)
        instance_count, instance_ready = await self._actual_instance_readiness(endpoint_id)
        snapshot["controller_ready_workers"] = instance_ready
        if self._instance_inspection_succeeded:
            snapshot["controller_verified"] = True
            snapshot["worker_count"] = instance_count
            # Controller state proves the worker belongs to the allowed pool;
            # live SDK registration proves a running row is actually serving.
            # Require both instead of trusting either stale source alone.
            snapshot["ready_workers"] = len(
                routing_ready_ids.intersection(self._instance_ready_ids)
            )
            snapshot["starting_workers"] = self._instance_health["starting"]
            snapshot["unhealthy_workers"] = self._instance_health["unhealthy"]
            snapshot["inactive_workers"] = self._instance_health["inactive"]
            snapshot["disallowed_workers"] = self._instance_health["disallowed"]
        else:
            # The SDK worker list does not carry the controller-side GPU,
            # hourly-price, label, or deny-list evidence required by policy.
            # Never admit an SDK-only READY row when that identity cannot be
            # intersected with a freshly verified allowed instance.
            snapshot["ready_workers"] = 0

        prepared = bool(snapshot["ready_workers"] or int(snapshot.get("inactive_workers") or 0))
        policy_clean = bool(snapshot["controller_verified"]) and not bool(
            int(snapshot.get("unhealthy_workers") or 0)
            or int(snapshot.get("disallowed_workers") or 0)
        )
        snapshot["cold_start_eligible"] = bool(workergroup_id and prepared and policy_clean)
        await self._reconcile_unhealthy_workers(endpoint_id, workergroup_id)
        snapshot["recovery_status"] = self._recovery_status
        if not snapshot["controller_verified"]:
            snapshot["reason"] = "Remote worker identity and cost policy could not be verified."
        elif snapshot["ready_workers"]:
            snapshot["reason"] = "Remote GPU ready."
        elif int(snapshot.get("disallowed_workers") or 0):
            snapshot["reason"] = "Remote GPU violated the allowed model-cost policy; an approved replacement is being prepared."
        elif int(snapshot.get("unhealthy_workers") or 0):
            snapshot["reason"] = "Remote GPU bootstrap exceeded its deadline; a replacement is being recruited."
        elif int(snapshot.get("inactive_workers") or 0):
            snapshot["reason"] = "Remote GPU cold worker is prepared and inactive; the next request will reactivate it."
        elif snapshot["worker_count"]:
            snapshot["reason"] = "Remote GPU worker is still starting."
        else:
            snapshot["reason"] = "Remote GPU cold capacity is being prepared; paid requests are temporarily paused."
        return snapshot

    async def _wait_for_remote_ready(self, deadline: float) -> bool:
        """Wait only through verified, policy-clean controller observations."""

        while time.monotonic() < deadline:
            # A stopped worker can transition on every poll; never reuse the
            # 15-second instance snapshot while proving a cold activation.
            self._instance_readiness_until = 0.0
            readiness = await self.remote_readiness()
            if readiness.get("controller_verified") is not True:
                raise HTTPException(
                    503,
                    "Remote GPU identity and cost policy became unverifiable during wake; no credits were reserved.",
                )
            if not readiness.get("workergroup_attached"):
                raise HTTPException(
                    503,
                    "Remote GPU worker group detached during wake; no credits were reserved.",
                )
            if (
                int(readiness.get("unhealthy_workers") or 0) > 0
                or int(readiness.get("disallowed_workers") or 0) > 0
            ):
                raise HTTPException(
                    503,
                    "Remote GPU pool left the approved health or cost policy during wake; no credits were reserved.",
                )
            if int(readiness.get("ready_workers") or 0) > 0:
                return True
            await asyncio.sleep(min(5.0, max(0.1, deadline - time.monotonic())))
        return False

    async def _wait_for_replacement_capacity(
        self,
        deadline: float,
        minimum_prepared_workers: int = 1,
    ) -> bool:
        """Wait for the controller-recruited standby without moving credits."""

        while time.monotonic() < deadline:
            # Controller state changes while a replacement downloads and loads;
            # bypass the short instance cache so the same user request can move
            # on as soon as the new model-ready sentinel appears.
            self._instance_readiness_until = 0.0
            readiness = await self.remote_readiness()
            prepared_workers = (
                int(readiness.get("ready_workers") or 0)
                + int(readiness.get("inactive_workers") or 0)
            )
            if readiness.get("cold_start_eligible") and prepared_workers >= max(
                1, minimum_prepared_workers
            ):
                return True
            await asyncio.sleep(min(5.0, max(0.1, deadline - time.monotonic())))
        return False

    @staticmethod
    def _worker_request_urls(worker_url: str) -> list[str]:
        """Return a narrowly scoped HTTP fallback for Vast's direct IP ports."""

        urls = [worker_url]
        parsed = urlsplit(worker_url)
        try:
            ipaddress.ip_address(parsed.hostname or "")
        except ValueError:
            return urls
        if parsed.scheme.casefold() == "https" and parsed.port:
            urls.append(urlunsplit(("http", parsed.netloc, parsed.path, parsed.query, parsed.fragment)))
        return urls

    @staticmethod
    async def _wait_for_routed_endpoint_ready(
        endpoint: Any, deadline: float
    ) -> bool:
        """Wait on the same scoped endpoint after an indeterminate first route.

        This must not consult the main Vision endpoint: Prompt Editor and Vision
        are separate worker groups and can have opposite readiness states.
        """

        while time.monotonic() < deadline:
            try:
                document = await endpoint.get_workers()
                workers = (
                    document.get("workers", document.get("results", []))
                    if isinstance(document, dict)
                    else document
                )
                for worker in workers if isinstance(workers, list) else []:
                    status = (
                        worker.get("status")
                        if isinstance(worker, dict)
                        else getattr(worker, "status", "")
                    )
                    if str(status or "").casefold() in {
                        "ready",
                        "running",
                        "active",
                    }:
                        return True
            except asyncio.CancelledError:
                raise
            except Exception:
                # The route call remains authoritative; worker-status reads are
                # advisory and can lag briefly during cold reactivation.
                pass
            await asyncio.sleep(min(1.0, max(0.1, deadline - time.monotonic())))
        return False

    async def _fast_routed_request(
        self,
        client: Any,
        managed_endpoint: Any,
        request_payload: dict[str, Any],
        deadline: float,
        *,
        cost: int = 100,
        before_send: Any = None,
        worker_timeout_seconds: float | None = None,
        zero_index_ready_waiter: Any = None,
    ) -> dict[str, Any]:
        """Poll a Vast route frequently enough to catch a newly ready worker.

        The SDK's general request loop uses exponential route-poll backoff. That
        is appropriate for long jobs, but it can add tens of seconds after a
        cold worker is already ready. This path polls once per second and then
        uses the SDK's authenticated transport.
        """

        if _vast_make_request is None:
            raise RuntimeError("Vast request transport unavailable")
        endpoint = (
            await managed_endpoint._get_routing_endpoint()
            if hasattr(managed_endpoint, "_get_routing_endpoint")
            else managed_endpoint
        )
        request_idx = 0
        route = None
        zero_index_recovery_used = False
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                # Vast's SDK already applies its own 10-second transport bound
                # and retry.  Only wrap it with the *overall* activation
                # deadline; a shorter wrapper used to cancel the SDK mid-retry
                # before it could return the request index.
                route = await asyncio.wait_for(
                    endpoint._route(
                        cost=cost,
                        req_idx=request_idx,
                        timeout=min(60.0, max(1.0, remaining)),
                    ),
                    timeout=max(0.1, remaining),
                )
            except (asyncio.TimeoutError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise TimeoutError("Remote route did not become ready")
                continue
            except RuntimeError as exc:
                # Endpoint._route wraps transient autoscaler transport failures
                # in this exact safe prefix.  Keep polling the same admission
                # request until the overall deadline; do not quarantine a GPU
                # because one controller status read failed.
                if not str(exc).startswith("Failed to route endpoint:"):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError("Remote route did not become ready") from exc
                if request_idx == 0:
                    # The first POST may have been accepted even though its
                    # response (and assigned request index) was lost. Do not
                    # hammer req_idx=0 and create parallel admission tickets.
                    # Let the one-worker floor finish its wake, then issue at
                    # most one fresh route request against the active worker.
                    if zero_index_recovery_used:
                        raise TimeoutError("Remote route admission remained indeterminate") from exc
                    zero_index_recovery_used = True
                    ready_waiter = (
                        zero_index_ready_waiter or self._wait_for_remote_ready
                    )
                    if not await ready_waiter(deadline):
                        raise TimeoutError("Remote route did not become ready") from exc
                    continue
                await asyncio.sleep(min(1.0, max(0.1, deadline - time.monotonic())))
                continue
            request_idx = int(route.request_idx or request_idx)
            if str(route.status or "").upper() == "READY":
                break
            await asyncio.sleep(min(1.0, max(0.1, deadline - time.monotonic())))
        else:
            raise TimeoutError("Remote route did not become ready")

        remaining = deadline - time.monotonic()
        if route is None or remaining <= 0:
            raise TimeoutError("Remote route did not become ready")
        if before_send is not None:
            await before_send()
        worker_deadline = (
            deadline
            if worker_timeout_seconds is None
            else time.monotonic() + max(1.0, float(worker_timeout_seconds))
        )
        result: dict[str, Any] | None = None
        last_error: Exception | None = None
        worker_urls = self._worker_request_urls(str(route.get_url() or ""))
        for worker_index, worker_url in enumerate(worker_urls):
            remaining = worker_deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Remote worker request deadline expired")
            # Direct Vast routes sometimes advertise HTTPS for a port serving
            # plain HTTP.  Never let that first protocol candidate consume the
            # full inference budget and starve the verified HTTP fallback.
            attempt_timeout = remaining
            if worker_index < len(worker_urls) - 1:
                attempt_timeout = min(12.0, max(1.0, remaining - 1.0))
            try:
                result = await asyncio.wait_for(
                    _vast_make_request(
                        client=client,
                        url=worker_url,
                        route="/v1/chat/completions",
                        api_key=endpoint.api_key,
                        body={
                            "auth_data": route.body,
                            "session_id": None,
                            "payload": request_payload,
                        },
                        method="POST",
                        retries=1,
                        timeout=max(1.0, attempt_timeout),
                        stream=False,
                    ),
                    timeout=max(0.1, attempt_timeout),
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = exc
                continue
            if result.get("ok"):
                break
            text = str(result.get("text") or "")
            if "HTTPS traffic on an HTTP port" in text:
                continue
            break
        if result is None:
            raise last_error or RuntimeError("Remote worker transport failed")
        return {
            "response": result.get("json"),
            "ok": bool(result.get("ok")),
            "status": result.get("status"),
            "text": result.get("text"),
        }

    def _record_activation_success(self, machine_ids: set[int]) -> None:
        with self._activation_evidence_lock:
            for machine_id in machine_ids:
                self._activation_failures.pop(machine_id, None)

    def _clear_activation_failures(self) -> None:
        with self._activation_evidence_lock:
            self._activation_failures.clear()

    def _record_activation_failure(self, machine_ids: set[int], request_id: str) -> bool:
        """Require two distinct failed images before blaming one exact standby."""

        if len(machine_ids) != 1 or not REQUEST_ID_RE.fullmatch(request_id):
            return False
        machine_id = next(iter(machine_ids))
        now = time.monotonic()
        cutoff = now - 60 * 60
        with self._activation_evidence_lock:
            evidence = {
                key: stamp
                for key, stamp in self._activation_failures.get(machine_id, {}).items()
                if stamp >= cutoff
            }
            evidence[request_id] = now
            self._activation_failures[machine_id] = evidence
            return len(evidence) >= 2

    async def _ensure_remote_active(self, request_id: str = "") -> None:
        """Prove the production cold route without moving app credits.

        A prepared Vast cold worker remains stopped until a route ticket exists;
        changing ``min_load`` alone does not reactivate it. Queue one tiny
        text-only request through the same authenticated route transport used by
        images, restore scale-to-zero as soon as that route is READY, and verify
        the worker response. This method is reserved for the authenticated
        administrative wake proof. Product images create their own single route
        so they never pay the latency or provider cost of a redundant probe.
        """

        async with self._activation_lock, self._activation_headroom_guard():
            started = time.monotonic()
            outcome = "failed"
            self._activation_started_at = started
            self._activation_phase = "checking-policy"
            try:
                self._instance_readiness_until = 0.0
                readiness = await self.remote_readiness()
                if readiness.get("controller_verified") is False:
                    raise HTTPException(
                        503,
                        "Remote GPU identity and cost policy could not be verified; no credits were reserved.",
                    )
                if (
                    int(readiness.get("unhealthy_workers") or 0) > 0
                    or int(readiness.get("disallowed_workers") or 0) > 0
                ):
                    raise HTTPException(
                        503,
                        "Remote GPU pool is being repaired to satisfy the approved GPU and cost policy; no credits were reserved.",
                    )
                if int(readiness.get("ready_workers") or 0) > 0:
                    if self._activation_headroom_target:
                        # A replacement can become READY between recovery
                        # attempts.  Collapse temporary cold headroom before
                        # this early success path returns, otherwise health
                        # reconciliation deliberately preserves cold_workers=2.
                        await asyncio.to_thread(
                            self._cancel_activation_recovery_headroom
                        )
                    self._clear_activation_failures()
                    outcome = "already-ready"
                    return
                if not readiness.get("cold_start_eligible"):
                    raise HTTPException(
                        503,
                        "Remote GPU cold capacity is still being prepared; no credits were reserved. Retry shortly or use Local GPU.",
                    )
                candidates = await asyncio.to_thread(self._prepared_activation_machine_ids)

                floor_restored = False
                activation_ready = False
                activation_cancelled = False
                activation_error: Exception | None = None
                try:
                    self._activation_phase = "raising-floor"
                    await self._set_activation_floor_async(1.0)
                    self._activation_phase = "routing-uncharged-proof"
                    route_deadline = time.monotonic() + self.config.activation_deadline_seconds
                    async with CoroutineServerless(
                        api_key=self.config.vast_api_key,
                        default_request_timeout=max(
                            self.config.activation_deadline_seconds,
                            min(30.0, self.config.inference_deadline_seconds),
                        ),
                    ) as client:
                        endpoint = await client.get_endpoint(self.config.vast_endpoint)

                        async def admit_uncharged_probe() -> None:
                            nonlocal floor_restored
                            self._activation_phase = "post-route-policy"
                            self._instance_readiness_until = 0.0
                            routed_readiness = await self.remote_readiness()
                            self._require_remote_capacity(
                                routed_readiness, require_ready=True
                            )
                            self._activation_phase = "restoring-scale-to-zero"
                            await self._restore_activation_floor()
                            floor_restored = True
                            self._activation_phase = "running-uncharged-proof"

                        probe_result = await self._fast_routed_request(
                            client,
                            endpoint,
                            {
                                "model": MODEL_ID,
                                "messages": [
                                    {"role": "user", "content": "Reply OK."}
                                ],
                                "temperature": 0,
                                "max_tokens": 2,
                                "stream": False,
                            },
                            route_deadline,
                            cost=1,
                            before_send=admit_uncharged_probe,
                            worker_timeout_seconds=min(
                                30.0, self.config.inference_deadline_seconds
                            ),
                        )
                    nested = (
                        probe_result.get("response")
                        if isinstance(probe_result, dict)
                        else None
                    )
                    if isinstance(nested, str):
                        try:
                            nested = json.loads(nested)
                        except json.JSONDecodeError:
                            nested = None
                    choices = nested.get("choices") if isinstance(nested, dict) else None
                    first_message = (
                        choices[0].get("message")
                        if isinstance(choices, list)
                        and choices
                        and isinstance(choices[0], dict)
                        else None
                    )
                    probe_content = (
                        first_message.get("content")
                        or first_message.get("reasoning_content")
                        if isinstance(first_message, dict)
                        else None
                    )
                    activation_ready = bool(
                        isinstance(probe_result, dict)
                        and probe_result.get("ok") is True
                        and isinstance(probe_content, str)
                        and probe_content.strip()
                    )
                    if not activation_ready:
                        raise RuntimeError("Remote uncharged wake proof returned no completion")
                except asyncio.CancelledError:
                    activation_cancelled = True
                except Exception as exc:
                    activation_error = exc
                finally:
                    if not floor_restored:
                        self._activation_phase = "restoring-scale-to-zero"
                        for attempt in range(3):
                            try:
                                await self._restore_activation_floor()
                                floor_restored = True
                                break
                            except asyncio.CancelledError:
                                activation_cancelled = True
                                floor_restored = True
                                break
                            except Exception:
                                if attempt < 2:
                                    await asyncio.sleep(1.0 + attempt)

                self._instance_readiness_until = 0.0
                if not floor_restored:
                    # The reset already switched our desired policy back to
                    # scale-to-zero before it attempted controller I/O.  Do
                    # not preserve recovery headroom indefinitely merely
                    # because that verification failed: the next successful
                    # health reconciliation must be free to collapse cold
                    # capacity back to one.
                    self._activation_headroom_target = 0
                    raise HTTPException(
                        503,
                        "Remote GPU wake safety reset could not be confirmed; no credits were reserved.",
                    )
                if activation_cancelled:
                    raise asyncio.CancelledError()
                if activation_ready:
                    self._record_activation_success(candidates)
                    outcome = "woke-verified-worker"
                    return

                if isinstance(activation_error, HTTPException):
                    # Controller identity/policy loss is not evidence that the
                    # prepared GPU itself failed. Preserve the precise fail-
                    # closed reason and never add a quarantine strike.
                    outcome = "controller-verification-failed"
                    raise activation_error

                repeated_exact_failure = self._record_activation_failure(
                    candidates, request_id
                )
                if repeated_exact_failure:
                    self._activation_phase = "quarantining-confirmed-failure"
                    quarantined = await asyncio.to_thread(
                        self._replace_failed_activation_workers,
                        candidates,
                    )
                    if quarantined:
                        self._recovery_status = "replacement-recruiting"
                        outcome = "confirmed-worker-quarantined"
                        raise HTTPException(
                            503,
                            "The failed remote standby was quarantined and an approved replacement is being prepared; no credits were reserved. Retry shortly or use Local GPU.",
                        )
                self._recovery_status = "activation-timeout"
                outcome = "wake-timeout"
                raise HTTPException(
                    503,
                    f"Remote GPU route proof did not complete within the {int(self.config.activation_deadline_seconds)}-second wake limit; no credits were reserved.",
                ) from activation_error
            finally:
                self._activation_last_elapsed_seconds = max(
                    0.0, time.monotonic() - started
                )
                self._activation_last_outcome = outcome
                self._activation_phase = "idle"
                self._activation_started_at = 0.0

    @staticmethod
    def _account_balance(db: sqlite3.Connection, discord_user_id: str) -> int:
        row = db.execute("SELECT available_credits FROM credit_accounts WHERE discord_user_id=?", (discord_user_id,)).fetchone()
        return int(row["available_credits"]) if row else 0

    @staticmethod
    def _preflight_credit_balance(
        db: sqlite3.Connection,
        license_row: sqlite3.Row | dict[str, Any],
    ) -> int:
        """Reject exhausted accounts before any provider-billable wake signal."""

        discord_user_id = str(license_row["discord_user_id"])
        row = db.execute(
            "SELECT available_credits FROM credit_accounts WHERE discord_user_id=?",
            (discord_user_id,),
        ).fetchone()
        # A newly enrolled active license deterministically receives the welcome
        # grant in the reservation transaction. Treat that not-yet-created row
        # as its pending welcome balance without writing during preflight.
        balance = int(row["available_credits"]) if row else WELCOME_CREDITS
        if balance < IMAGE_CREDIT_COST:
            raise HTTPException(
                402,
                "Online API credits are exhausted. Purchase a Bitcoin credit pack or select Local GPU.",
            )
        return balance

    def _require_remote_capacity(
        self,
        readiness: dict[str, Any],
        *,
        require_ready: bool = False,
    ) -> None:
        """Apply the same controller/GPU policy at every admission boundary."""

        if not readiness.get("workergroup_attached"):
            raise HTTPException(
                503,
                "Remote GPU worker group is unavailable; no credits were reserved. Retry shortly or use Local GPU.",
            )
        if readiness.get("controller_verified") is not True:
            raise HTTPException(
                503,
                "Remote GPU identity and cost policy could not be verified; no credits were reserved. Retry shortly or use Local GPU.",
            )
        if (
            int(readiness.get("unhealthy_workers") or 0) > 0
            or int(readiness.get("disallowed_workers") or 0) > 0
        ):
            raise HTTPException(
                503,
                "Remote GPU pool is being repaired to satisfy the approved GPU and cost policy; no credits were reserved. Retry shortly or use Local GPU.",
            )
        if require_ready:
            # This branch is called only after the exact SDK route object has
            # returned READY. Vast's separate endpoint.get_workers() list can
            # lag that route by a minute, so pair the route proof with the fresh
            # allowed controller/model-ready instance count instead of requiring
            # a second routing view to agree immediately.
            unique_controller_route = bool(
                int(readiness.get("controller_ready_workers") or 0) == 1
                and int(readiness.get("worker_count") or 0) == 1
                and int(readiness.get("inactive_workers") or 0) == 0
                and int(readiness.get("starting_workers") or 0) == 0
            )
            if (
                int(readiness.get("ready_workers") or 0) <= 0
                and not unique_controller_route
            ):
                raise HTTPException(
                    503,
                    "The routed remote GPU could not be re-verified before billing; no credits were reserved.",
                )
            return
        if not (
            int(readiness.get("ready_workers") or 0) > 0
            or readiness.get("cold_start_eligible") is True
        ):
            raise HTTPException(
                503,
                "Remote GPU cold capacity is still being prepared; no credits were reserved. Retry shortly or use Local GPU.",
            )

    def _grant_welcome_credits(self, db: sqlite3.Connection, discord_user_id: str, now: int) -> None:
        inserted = db.execute(
            "INSERT OR IGNORE INTO credit_accounts(discord_user_id,available_credits,created_at,updated_at) VALUES(?,?,?,?)",
            (discord_user_id, WELCOME_CREDITS, now, now),
        ).rowcount
        if inserted:
            db.execute(
                "INSERT INTO credit_ledger(discord_user_id,delta_credits,entry_kind,idempotency_key,created_at) VALUES(?,?,?,?,?)",
                (discord_user_id, WELCOME_CREDITS, "welcome", f"welcome:{discord_user_id}", now),
            )

    def start_oauth(self, request: OAuthStartRequest) -> dict[str, str | int]:
        if not self.oauth_configured():
            raise HTTPException(503, "The Online API Discord sign-in is not configured yet.")
        enrollment_id, enrollment_secret = request.enrollment_id.strip(), request.enrollment_secret.strip()
        installation_id = request.installation_id.strip()
        if not (
            ENROLLMENT_ID_RE.fullmatch(enrollment_id)
            and ENROLLMENT_SECRET_RE.fullmatch(enrollment_secret)
            and re.fullmatch(r"[A-Za-z0-9_-]{24,128}", installation_id)
        ):
            raise HTTPException(422, "The Online API enrollment request is invalid.")
        state = secrets.token_urlsafe(32)
        now = int(time.time())
        salt = secrets.token_hex(16)
        install_digest = hashlib.sha256(installation_id.encode("utf-8")).hexdigest()
        with self.connection() as db:
            db.execute("DELETE FROM oauth_enrollments WHERE expires_at < ?", (now,))
            db.execute(
                "INSERT INTO oauth_enrollments(enrollment_id,enrollment_salt,enrollment_digest,installation_digest,state,status,created_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(enrollment_id) DO UPDATE SET enrollment_salt=excluded.enrollment_salt,enrollment_digest=excluded.enrollment_digest,installation_digest=excluded.installation_digest,state=excluded.state,status='pending',created_at=excluded.created_at,expires_at=excluded.expires_at,completed_at=NULL,delivered_at=NULL,discord_user_id=NULL,discord_username=NULL,license_id=NULL",
                (enrollment_id, salt, token_hash(salt, enrollment_secret), install_digest, state, now, now + OAUTH_ENROLLMENT_TTL_SECONDS),
            )
        params = {
            "response_type": "code", "client_id": self.config.discord_client_id,
            "scope": "identify", "redirect_uri": self.config.discord_redirect_uri,
            "state": state, "prompt": "consent",
        }
        query = urlencode(params)
        return {"enrollment_id": enrollment_id, "authorize_url": f"https://discord.com/oauth2/authorize?{query}", "expires_in_seconds": OAUTH_ENROLLMENT_TTL_SECONDS}

    def _enrollment(self, enrollment_id: str, enrollment_secret: str) -> sqlite3.Row:
        if not ENROLLMENT_ID_RE.fullmatch(enrollment_id) or not ENROLLMENT_SECRET_RE.fullmatch(enrollment_secret):
            raise HTTPException(401, "Online API enrollment is invalid.")
        with self.connection() as db:
            row = db.execute("SELECT * FROM oauth_enrollments WHERE enrollment_id=?", (enrollment_id,)).fetchone()
            if not row or not hmac.compare_digest(row["enrollment_digest"], token_hash(row["enrollment_salt"], enrollment_secret)):
                raise HTTPException(401, "Online API enrollment is invalid.")
            if row["expires_at"] < int(time.time()):
                db.execute("UPDATE oauth_enrollments SET status='expired' WHERE enrollment_id=?", (enrollment_id,))
                raise HTTPException(410, "Online API sign-in expired. Start again.")
            return row

    def oauth_status(self, enrollment_id: str, enrollment_secret: str) -> dict[str, str]:
        row = self._enrollment(enrollment_id, enrollment_secret)
        status = str(row["status"])
        if status != "complete":
            return {"status": status}
        if row["delivered_at"] is not None or not row["license_id"]:
            return {"status": "delivered"}
        license_id = str(row["license_id"])
        token = deterministic_license_token(self.config.license_signing_key, license_id, enrollment_id)
        with self.connection() as db:
            db.execute("UPDATE oauth_enrollments SET delivered_at=? WHERE enrollment_id=? AND delivered_at IS NULL", (int(time.time()), enrollment_id))
        return {
            "status": "complete",
            "license_id": license_id,
            "license_token": token,
            "discord_user_id": str(row["discord_user_id"]),
            "discord_username": clean_text(row["discord_username"], 80),
        }

    def oauth_callback(self, state: str, code: str = "", error: str = "") -> tuple[int, str]:
        if not OAUTH_STATE_RE.fullmatch(state):
            return 400, "The Discord sign-in state is invalid. Return to Discord and try again."
        with self.connection() as db:
            enrollment = db.execute("SELECT * FROM oauth_enrollments WHERE state=?", (state,)).fetchone()
        if not enrollment or enrollment["expires_at"] < int(time.time()):
            return 400, "This Discord sign-in has expired. Return to Discord and start again."
        if enrollment["status"] != "pending":
            return 400, "This Discord sign-in was already completed. Return to KREA2 Vision Suite."
        if error or not code:
            with self.connection() as db:
                db.execute("UPDATE oauth_enrollments SET status='denied', completed_at=? WHERE enrollment_id=?", (int(time.time()), enrollment["enrollment_id"]))
            return 400, "Discord sign-in was cancelled or denied. Return to Discord and try again."
        try:
            token_response = self.http.post(
                "https://discord.com/api/oauth2/token",
                data={"grant_type":"authorization_code", "code":code, "redirect_uri":self.config.discord_redirect_uri},
                auth=(self.config.discord_client_id, self.config.discord_client_secret),
                timeout=12,
            )
            token_body = token_response.json()
            access_token = str(token_body.get("access_token") or "")
            identity_response = self.http.get("https://discord.com/api/v10/users/@me", headers={"Authorization":f"Bearer {access_token}"}, timeout=12)
            identity = identity_response.json()
            user_id = str(identity.get("id") or "")
            username = clean_text(identity.get("global_name") or identity.get("username"), 80)
            if getattr(token_response, "status_code", 500) >= 400 or getattr(identity_response, "status_code", 500) >= 400 or not DISCORD_ID_RE.fullmatch(user_id) or not username:
                raise ValueError("Discord identity verification failed")
        except Exception:
            return 502, "Discord identity verification failed. Return to Discord and try again."
        now = int(time.time())
        license_id = "lic_" + secrets.token_urlsafe(18).replace("-", "_")
        token_salt = secrets.token_hex(16)
        token = deterministic_license_token(self.config.license_signing_key, license_id, str(enrollment["enrollment_id"]))
        with self.connection() as db:
            banned = db.execute("SELECT 1 FROM licenses WHERE discord_user_id=? AND status IN ('suspended','revoked') LIMIT 1", (user_id,)).fetchone()
            if banned:
                db.execute("UPDATE oauth_enrollments SET status='denied', completed_at=? WHERE enrollment_id=?", (now, enrollment["enrollment_id"]))
                return 403, "Online API access is unavailable for this Discord account."
            db.execute("UPDATE licenses SET status='suspended', revoked_at=?, revoked_reason='replaced after Discord OAuth enrollment' WHERE discord_user_id=? AND installation_digest=? AND status='active'", (now, user_id, enrollment["installation_digest"]))
            db.execute("INSERT INTO licenses(license_id,discord_user_id,discord_username,installation_digest,token_salt,token_digest,auth_method,status,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (license_id, user_id, username, enrollment["installation_digest"], token_salt, token_hash(token_salt, token), "discord_oauth", "active", now, now))
            self._grant_welcome_credits(db, user_id, now)
            db.execute("UPDATE oauth_enrollments SET status='complete', completed_at=?, discord_user_id=?, discord_username=?, license_id=? WHERE enrollment_id=?", (now, user_id, username, license_id, enrollment["enrollment_id"]))
        return 200, "Discord account verified. You can close this page and return to KREA2 Vision Suite."

    def authenticate_license(self, authorization: str | None) -> sqlite3.Row:
        license_id, token = parse_bearer(authorization)
        with self.connection() as db:
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if not row or not hmac.compare_digest(row["token_digest"], token_hash(row["token_salt"], token)):
                raise HTTPException(401, "The remote KREA2 license is invalid.")
            if row["status"] != "active" or row["auth_method"] != "discord_oauth":
                raise HTTPException(403, "Remote KREA2 API access is unavailable for this Discord account.")
            db.execute("UPDATE licenses SET last_seen_at=? WHERE license_id=?", (int(time.time()), license_id))
            return row

    def authenticate(self, authorization: str | None, request_id: str) -> sqlite3.Row:
        if not REQUEST_ID_RE.fullmatch(request_id):
            raise HTTPException(422, "Remote request provenance is invalid.")
        return self.authenticate_license(authorization)

    @staticmethod
    def _credit_pack_item_code(pack_id: str) -> str:
        return f"krea2-credit-pack-{pack_id}"

    @staticmethod
    def _intro_pack_used(db: sqlite3.Connection, discord_user_id: str) -> bool:
        return db.execute(
            "SELECT 1 FROM credit_invoices WHERE discord_user_id=? AND pack_id=? AND status='settled' LIMIT 1",
            (discord_user_id, INTRO_CREDIT_PACK_ID),
        ).fetchone() is not None

    def _available_credit_packs(
        self,
        db: sqlite3.Connection,
        discord_user_id: str,
    ) -> list[dict[str, str | int | bool]]:
        intro_used = self._intro_pack_used(db, discord_user_id)
        pending_intro = db.execute(
            "SELECT 1 FROM credit_invoices WHERE discord_user_id=? AND pack_id=? AND status='new' LIMIT 1",
            (discord_user_id, INTRO_CREDIT_PACK_ID),
        ).fetchone() is not None
        available: list[dict[str, str | int | bool]] = []
        for pack_id, definition in CREDIT_PACKS.items():
            # The starter is the entire first-purchase offer. Regular tiers
            # replace it only after its settled payment has been recorded.
            if intro_used != (pack_id != INTRO_CREDIT_PACK_ID):
                continue
            credits = int(definition["credits"])
            available.append({
                "id": pack_id,
                "credits": credits,
                "price_usd": str(definition["price_usd"]),
                "one_time": bool(definition["one_time"]),
                "pending": bool(pack_id == INTRO_CREDIT_PACK_ID and pending_intro),
                "label": str(definition["label"]),
                "vision_images": credits // IMAGE_CREDIT_COST,
                "qwen_output_tokens": credits * PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
            })
        return available

    def credit_status(self, license_row: sqlite3.Row) -> dict[str, Any]:
        self._reconcile_credit_invoices(str(license_row["discord_user_id"]))
        with self.connection() as db:
            now = int(time.time())
            self._release_stale_reservations(db, now)
            self._grant_welcome_credits(db, str(license_row["discord_user_id"]), now)
            balance = self._account_balance(db, str(license_row["discord_user_id"]))
            packs = self._available_credit_packs(db, str(license_row["discord_user_id"]))
        preferred_pack = packs[0]
        return {
            "available_credits": balance,
            "credits_per_image": IMAGE_CREDIT_COST,
            "images_available": balance // IMAGE_CREDIT_COST,
            "credits_per_prompt_chat": PROMPT_CHAT_CREDIT_COST,
            "prompt_chat_turns_available": balance // PROMPT_CHAT_CREDIT_COST,
            "prompt_chat_output_tokens_per_credit": PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
            "prompt_chat_output_tokens_available": balance * PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
            # Retained for pre-selectable-pack clients. The values always
            # mirror the first currently eligible pack.
            "pack_credits": int(preferred_pack["credits"]),
            "pack_price_usd": str(preferred_pack["price_usd"]),
            "credit_packs": packs,
            "intro_pack_available": any(pack["id"] == INTRO_CREDIT_PACK_ID for pack in packs),
            "payments_configured": self.btcpay_configured(),
        }

    def _reserve_image_credits(
        self,
        db: sqlite3.Connection,
        license_row: sqlite3.Row,
        request_id: str,
        request_digest: str,
        now: int,
    ) -> bool:
        """Reserve this image once and report whether this call owns the hold."""

        self._assert_unused_request_id(
            db, license_row, request_id, request_digest
        )
        self._grant_welcome_credits(db, str(license_row["discord_user_id"]), now)
        updated = db.execute(
            "UPDATE credit_accounts SET available_credits=available_credits-?,updated_at=? WHERE discord_user_id=? AND available_credits>=?",
            (IMAGE_CREDIT_COST, now, license_row["discord_user_id"], IMAGE_CREDIT_COST),
        ).rowcount
        if not updated:
            raise HTTPException(402, "Online API credits are exhausted. Purchase a Bitcoin credit pack or select Local GPU.")
        db.execute(
            "INSERT INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
            (license_row["discord_user_id"], -IMAGE_CREDIT_COST, "image_reservation", request_id, f"reserve:{request_id}", now),
        )
        db.execute(
            "INSERT INTO remote_jobs(request_id,license_id,model_id,discord_user_id,discord_username,started_at,calls,credit_state,request_digest) VALUES(?,?,?,?,?,?,1,'reserved',?)",
            (
                request_id,
                license_row["license_id"],
                PUBLIC_MODEL_ID,
                license_row["discord_user_id"],
                license_row["discord_username"],
                now,
                request_digest,
            ),
        )
        return True

    @staticmethod
    def _assert_unused_request_id(
        db: sqlite3.Connection,
        license_row: sqlite3.Row | dict[str, Any],
        request_id: str,
        request_digest: str,
    ) -> None:
        """Reject request replay before either GPU wake or credit mutation."""

        if not re.fullmatch(r"[a-f0-9]{64}", request_digest):
            raise HTTPException(422, "Remote request content proof is invalid.")
        job = db.execute(
            "SELECT license_id,credit_state,request_digest FROM remote_jobs WHERE request_id=?",
            (request_id,),
        ).fetchone()
        if job:
            if job["license_id"] != license_row["license_id"]:
                raise HTTPException(409, "Remote request ownership is invalid.")
            if not job["request_digest"] or not hmac.compare_digest(
                str(job["request_digest"]), request_digest
            ):
                raise HTTPException(409, "Remote request ID was already bound to different image content.")
            if job["credit_state"] in {"reserved", "charged"}:
                raise HTTPException(409, "Remote request ID is already in progress or completed; start a new image job.")
            if job["credit_state"] == "refunded":
                raise HTTPException(409, "A refunded remote request ID cannot be reused; start a new image job.")
            raise HTTPException(409, "Remote request ID was already used; start a new image job.")

    def _release_image_credits(self, db: sqlite3.Connection, license_row: sqlite3.Row, request_id: str, now: int) -> bool:
        changed = db.execute(
            "UPDATE remote_jobs SET credit_state='refunded' WHERE request_id=? AND license_id=? AND credit_state='reserved'",
            (request_id, license_row["license_id"]),
        ).rowcount
        if not changed:
            return False
        db.execute("UPDATE credit_accounts SET available_credits=available_credits+?,updated_at=? WHERE discord_user_id=?", (IMAGE_CREDIT_COST, now, license_row["discord_user_id"]))
        db.execute(
            "INSERT INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
            (license_row["discord_user_id"], IMAGE_CREDIT_COST, "image_refund", request_id, f"refund:{request_id}", now),
        )
        return True

    def _release_stale_reservations(self, db: sqlite3.Connection, now: int) -> int:
        """Return abandoned image holds if a client disappears before it can report failure."""
        stale = db.execute(
            "SELECT request_id,discord_user_id FROM remote_jobs WHERE credit_state='reserved' AND started_at<?",
            (now - CREDIT_RESERVATION_TTL_SECONDS,),
        ).fetchall()
        released = 0
        for job in stale:
            if not db.execute("UPDATE remote_jobs SET credit_state='refunded' WHERE request_id=? AND credit_state='reserved'", (job["request_id"],)).rowcount:
                continue
            db.execute("UPDATE credit_accounts SET available_credits=available_credits+?,updated_at=? WHERE discord_user_id=?", (IMAGE_CREDIT_COST, now, job["discord_user_id"]))
            db.execute(
                "INSERT OR IGNORE INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
                (job["discord_user_id"], IMAGE_CREDIT_COST, "stale_image_refund", job["request_id"], f"refund:{job['request_id']}", now),
            )
            released += 1
        stale_chat = db.execute(
            "SELECT request_id,discord_user_id FROM prompt_chat_jobs WHERE credit_state='reserved' AND started_at<?",
            (now - CREDIT_RESERVATION_TTL_SECONDS,),
        ).fetchall()
        for job in stale_chat:
            reserved_credits = self._prompt_chat_reserved_credits(
                db, str(job["request_id"]), str(job["discord_user_id"])
            )
            if not db.execute(
                "UPDATE prompt_chat_jobs SET credit_state='refunded' WHERE request_id=? AND credit_state='reserved'",
                (job["request_id"],),
            ).rowcount:
                continue
            db.execute(
                "UPDATE credit_accounts SET available_credits=available_credits+?,updated_at=? WHERE discord_user_id=?",
                (reserved_credits, now, job["discord_user_id"]),
            )
            db.execute(
                "INSERT OR IGNORE INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
                (job["discord_user_id"], reserved_credits, "prompt_chat_refund", job["request_id"], f"prompt-chat-refund:{job['request_id']}", now),
            )
            released += 1
        return released

    @staticmethod
    def _prompt_chat_content(payload: PromptChatRequest) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        total_chars = 0
        for item in payload.messages:
            role = item.role.strip().casefold()
            content = item.content.strip()
            if role not in {"user", "assistant"}:
                raise HTTPException(422, "Prompt Editor accepts only user and assistant turns.")
            if not content:
                raise HTTPException(422, "Prompt Editor messages cannot be empty.")
            total_chars += len(content)
            messages.append({"role": role, "content": content})
        if messages[-1]["role"] != "user":
            raise HTTPException(422, "Prompt Editor conversations must end with a user request.")
        if total_chars > 48000:
            raise HTTPException(413, "The Prompt Editor conversation is too large. Start a new chat.")
        return messages

    @staticmethod
    def _prompt_chat_reply(result: Any) -> str:
        if not isinstance(result, dict) or result.get("ok") is False:
            raise RuntimeError("Qwen Prompt Editor returned an unusable response.")
        nested = result.get("response", result)
        if isinstance(nested, str):
            nested = json.loads(nested)
        choices = nested.get("choices") if isinstance(nested, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Qwen Prompt Editor returned an empty response.")
        cleaned = re.sub(r"<think\b[^>]*>.*?</think\s*>", "", content, flags=re.I | re.S).strip()
        if "</think>" in cleaned.casefold():
            cleaned = re.split(r"</think\s*>", cleaned, flags=re.I)[-1].strip()
        if not cleaned or len(cleaned) > 24000:
            raise RuntimeError("Qwen Prompt Editor returned invalid text.")
        return cleaned

    @staticmethod
    def _prompt_chat_output_tokens(result: Any) -> int:
        if not isinstance(result, dict) or result.get("ok") is False:
            raise RuntimeError("Qwen Prompt Editor returned unusable token accounting.")
        nested = result.get("response", result)
        if isinstance(nested, str):
            nested = json.loads(nested)
        usage = nested.get("usage") if isinstance(nested, dict) else None
        raw_tokens = (
            usage.get("completion_tokens", usage.get("output_tokens"))
            if isinstance(usage, dict)
            else None
        )
        if isinstance(raw_tokens, bool):
            raise RuntimeError("Qwen Prompt Editor returned invalid token accounting.")
        try:
            output_tokens = int(raw_tokens)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "Qwen Prompt Editor did not return exact output-token accounting."
            ) from exc
        if output_tokens < 1 or output_tokens > 4096:
            raise RuntimeError("Qwen Prompt Editor output-token accounting is out of range.")
        return output_tokens

    def _assert_unused_prompt_chat_request(
        self,
        db: sqlite3.Connection,
        license_row: sqlite3.Row,
        request_id: str,
        request_digest: str,
    ) -> None:
        row = db.execute(
            "SELECT license_id,request_digest,credit_state FROM prompt_chat_jobs WHERE request_id=?",
            (request_id,),
        ).fetchone()
        if not row:
            return
        if row["license_id"] != license_row["license_id"]:
            raise HTTPException(409, "Prompt Editor request ownership is invalid.")
        if not hmac.compare_digest(str(row["request_digest"]), request_digest):
            raise HTTPException(409, "Prompt Editor request ID was already bound to different content.")
        raise HTTPException(409, "Prompt Editor request ID was already used. Send the message again.")

    def _reserve_prompt_chat_credit(
        self,
        db: sqlite3.Connection,
        license_row: sqlite3.Row,
        request_id: str,
        request_digest: str,
        now: int,
        credits: int,
    ) -> None:
        if not isinstance(credits, int) or credits < PROMPT_CHAT_CREDIT_COST:
            raise RuntimeError("Prompt Editor credit reservation is invalid.")
        self._assert_unused_prompt_chat_request(db, license_row, request_id, request_digest)
        self._grant_welcome_credits(db, str(license_row["discord_user_id"]), now)
        changed = db.execute(
            "UPDATE credit_accounts SET available_credits=available_credits-?,updated_at=? WHERE discord_user_id=? AND available_credits>=?",
            (credits, now, license_row["discord_user_id"], credits),
        ).rowcount
        if not changed:
            raise HTTPException(402, "Prompt Editor credits are exhausted. Purchase a Bitcoin credit pack.")
        db.execute(
            "INSERT INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
            (license_row["discord_user_id"], -credits, "prompt_chat_reservation", request_id, f"prompt-chat-reserve:{request_id}", now),
        )
        db.execute(
            "INSERT INTO prompt_chat_jobs(request_id,license_id,discord_user_id,model_id,request_digest,credit_state,started_at) VALUES(?,?,?,?,?,'reserved',?)",
            (request_id, license_row["license_id"], license_row["discord_user_id"], PROMPT_CHAT_MODEL_ID, request_digest, now),
        )

    @staticmethod
    def _prompt_chat_reserved_credits(
        db: sqlite3.Connection,
        request_id: str,
        discord_user_id: str,
    ) -> int:
        row = db.execute(
            "SELECT delta_credits FROM credit_ledger WHERE request_id=? AND discord_user_id=? AND entry_kind='prompt_chat_reservation'",
            (request_id, discord_user_id),
        ).fetchone()
        credits = -int(row["delta_credits"]) if row else 0
        if credits < PROMPT_CHAT_CREDIT_COST:
            raise RuntimeError("Prompt Editor credit reservation could not be verified.")
        return credits

    def _refund_prompt_chat_credit(
        self,
        db: sqlite3.Connection,
        license_row: sqlite3.Row,
        request_id: str,
        now: int,
    ) -> None:
        reserved_credits = self._prompt_chat_reserved_credits(
            db, request_id, str(license_row["discord_user_id"])
        )
        changed = db.execute(
            "UPDATE prompt_chat_jobs SET credit_state='refunded',completed_at=? WHERE request_id=? AND license_id=? AND credit_state='reserved'",
            (now, request_id, license_row["license_id"]),
        ).rowcount
        if not changed:
            return
        db.execute(
            "UPDATE credit_accounts SET available_credits=available_credits+?,updated_at=? WHERE discord_user_id=?",
            (reserved_credits, now, license_row["discord_user_id"]),
        )
        db.execute(
            "INSERT OR IGNORE INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
            (license_row["discord_user_id"], reserved_credits, "prompt_chat_refund", request_id, f"prompt-chat-refund:{request_id}", now),
        )

    def _settle_prompt_chat_credit(
        self,
        db: sqlite3.Connection,
        license_row: sqlite3.Row,
        request_id: str,
        output_tokens: int,
        now: int,
    ) -> tuple[int, int]:
        charged_credits = max(
            PROMPT_CHAT_CREDIT_COST,
            (output_tokens + PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT - 1)
            // PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
        )
        reserved_credits = self._prompt_chat_reserved_credits(
            db, request_id, str(license_row["discord_user_id"])
        )
        if charged_credits > reserved_credits:
            raise RuntimeError("Prompt Editor output exceeded its reserved credit ceiling.")
        changed = db.execute(
            "UPDATE prompt_chat_jobs SET credit_state='charged',completed_at=? WHERE request_id=? AND license_id=? AND credit_state='reserved'",
            (now, request_id, license_row["license_id"]),
        ).rowcount
        if changed != 1:
            raise RuntimeError("Prompt Editor credit settlement could not be confirmed.")
        unused_credits = reserved_credits - charged_credits
        if unused_credits:
            db.execute(
                "UPDATE credit_accounts SET available_credits=available_credits+?,updated_at=? WHERE discord_user_id=?",
                (unused_credits, now, license_row["discord_user_id"]),
            )
            db.execute(
                "INSERT INTO credit_ledger(discord_user_id,delta_credits,entry_kind,request_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
                (
                    license_row["discord_user_id"],
                    unused_credits,
                    "prompt_chat_unused_refund",
                    request_id,
                    f"prompt-chat-unused:{request_id}",
                    now,
                ),
            )
        return charged_credits, self._account_balance(
            db, str(license_row["discord_user_id"])
        )

    async def prompt_chat(
        self,
        payload: PromptChatRequest,
        license_row: sqlite3.Row,
        request_id: str,
    ) -> dict[str, Any]:
        if payload.model != PROMPT_CHAT_MODEL_ID or payload.stream:
            raise HTTPException(422, "Only the pinned Qwen 3.8 Prompt Editor model is available.")
        prompt_chat_api_key = self.config.prompt_chat_api_key
        if (
            not self.dedicated_configured()
            and (
                not self.config.prompt_chat_endpoint
                or len(prompt_chat_api_key) < 24
                or CoroutineServerless is None
            )
        ):
            raise HTTPException(503, "Qwen Prompt Editor is not configured.")
        messages = self._prompt_chat_content(payload)
        request_document = {
            "model": PROMPT_CHAT_MODEL_ID,
            "messages": messages,
            "temperature": payload.temperature,
            "max_tokens": payload.max_tokens,
            "stream": False,
        }
        request_digest = hashlib.sha256(
            json.dumps(request_document, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        system_prompt = (
            "You are KREA2 Prompt Editor, an expert at revising image-generation prompts. "
            "Preserve every visual fact the user did not ask to change, including subject, pose, anatomy, outfit, camera, lighting, setting, color, texture, and photographic character. "
            "Make exactly the requested edits. When the user asks for a rewrite, return only the complete revised prompt with no preface, explanation, markdown fence, negative prompt, or commentary. "
            "When the user asks a direct question, answer it briefly. You cannot see the source image; work only from the supplied prompt and conversation."
        )
        provider_payload = {
            **request_document,
            "messages": [{"role": "system", "content": system_prompt}, *messages],
            "chat_template_kwargs": {"enable_thinking": False},
        }
        with self.connection() as db:
            now = int(time.time())
            self._release_stale_reservations(db, now)
            self._assert_unused_prompt_chat_request(db, license_row, request_id, request_digest)
            self._grant_welcome_credits(db, str(license_row["discord_user_id"]), now)
            available_credits = self._account_balance(
                db, str(license_row["discord_user_id"])
            )
            if available_credits < PROMPT_CHAT_CREDIT_COST:
                raise HTTPException(402, "Prompt Editor credits are exhausted. Purchase a Bitcoin credit pack.")
            requested_credit_ceiling = max(
                PROMPT_CHAT_CREDIT_COST,
                (payload.max_tokens + PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT - 1)
                // PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
            )
            reservation_credits = min(requested_credit_ceiling, available_credits)
        provider_payload["max_tokens"] = min(
            payload.max_tokens,
            reservation_credits * PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
        )
        if self.dedicated_configured():
            reserved = False
            failure_stage = "preparing-dedicated-qwen"
            try:
                async with self._prompt_chat_lock:
                    failure_stage = "reserving-credit"
                    with self.connection() as db:
                        now = int(time.time())
                        self._release_stale_reservations(db, now)
                        self._reserve_prompt_chat_credit(
                            db,
                            license_row,
                            request_id,
                            request_digest,
                            now,
                            reservation_credits,
                        )
                        reserved = True
                    failure_stage = "dedicated-queue-and-inference"
                    result = await self._dedicated_completion(
                        provider_payload,
                        model=DEDICATED_QWEN_MODEL_ID,
                        timeout_seconds=self.config.prompt_chat_timeout_seconds,
                    )
                    failure_stage = "validating-reply"
                    reply = self._prompt_chat_reply(result)
                    output_tokens = self._prompt_chat_output_tokens(result)
                    if output_tokens > int(provider_payload["max_tokens"]):
                        raise RuntimeError("Qwen Prompt Editor exceeded its output-token limit.")
                    failure_stage = "settling-credit"
                    with self.connection() as db:
                        now = int(time.time())
                        charged_credits, balance = self._settle_prompt_chat_credit(
                            db,
                            license_row,
                            request_id,
                            output_tokens,
                            now,
                        )
                    return {
                        "reply": reply,
                        "model": PROMPT_CHAT_MODEL_ID,
                        "credits_charged": charged_credits,
                        "output_tokens": output_tokens,
                        "output_tokens_per_credit": PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
                        "available_credits": balance,
                        "privacy": "conversation content is forwarded for inference and is not stored by the KREA2 gateway",
                    }
            except asyncio.CancelledError:
                if reserved:
                    with self.connection() as db:
                        self._refund_prompt_chat_credit(
                            db, license_row, request_id, int(time.time())
                        )
                raise
            except HTTPException:
                if reserved:
                    with self.connection() as db:
                        self._refund_prompt_chat_credit(
                            db, license_row, request_id, int(time.time())
                        )
                raise
            except Exception as exc:
                if reserved:
                    with self.connection() as db:
                        self._refund_prompt_chat_credit(
                            db, license_row, request_id, int(time.time())
                        )
                safe_error = redact_error_report_text(
                    f"{type(exc).__name__}: {exc}", 1200
                ).replace("\n", " ")
                LOGGER.error(
                    "Prompt Editor request %s failed during %s: %s",
                    request_id[:12],
                    failure_stage,
                    safe_error,
                )
                raise HTTPException(
                    503,
                    "Qwen Prompt Editor is warming or temporarily unavailable; no credit was charged.",
                ) from exc
        reserved = False
        failure_stage = "preparing"
        try:
            async with self._prompt_chat_lock:
                failure_stage = "reserving-credit"
                with self.connection() as db:
                    now = int(time.time())
                    self._release_stale_reservations(db, now)
                    self._reserve_prompt_chat_credit(
                        db,
                        license_row,
                        request_id,
                        request_digest,
                        now,
                        reservation_credits,
                    )
                    reserved = True
                failure_stage = "activating-qwen"
                async with self._prompt_chat_activation_guard():
                    # Vast's management key can resolve endpoint metadata but is
                    # not authorized to route this worker group. Conversely, the
                    # Qwen worker-group key can route and authenticate the worker
                    # but cannot call get_endpoint(). Resolve with the management
                    # client, then construct a partial endpoint bound exclusively
                    # to the Qwen client/key. Do not pass managed.data: Endpoint_
                    # deliberately prefers that object's embedded management key
                    # and would silently ignore the explicit route key.
                    async with CoroutineServerless(
                        api_key=self.config.vast_api_key,
                        default_request_timeout=self.config.prompt_chat_timeout_seconds,
                    ) as manager:
                        failure_stage = "resolving-qwen-endpoint"
                        managed_endpoint = await manager.get_endpoint(
                            self.config.prompt_chat_endpoint
                        )
                        endpoint_type = type(managed_endpoint)
                        endpoint_name = str(managed_endpoint.name)
                        endpoint_id = int(managed_endpoint.id)
                    async with CoroutineServerless(
                        api_key=prompt_chat_api_key,
                        default_request_timeout=self.config.prompt_chat_timeout_seconds,
                    ) as router:
                        endpoint = endpoint_type(
                            client=router,
                            name=endpoint_name,
                            id=endpoint_id,
                            api_key=prompt_chat_api_key,
                            soft_refresh_threshold=float("inf"),
                            hard_refresh_threshold=float("inf"),
                        )
                        if not hmac.compare_digest(
                            str(endpoint.api_key), prompt_chat_api_key
                        ):
                            raise RuntimeError(
                                "Qwen routing endpoint did not retain its scoped credential"
                            )

                        async def wait_for_qwen_ready(
                            wait_deadline: float,
                        ) -> bool:
                            return await self._wait_for_routed_endpoint_ready(
                                endpoint, wait_deadline
                            )

                        failure_stage = "routing-and-inference"
                        result = await self._fast_routed_request(
                            router,
                            endpoint,
                            provider_payload,
                            time.monotonic() + self.config.prompt_chat_timeout_seconds,
                            cost=int(provider_payload["max_tokens"]),
                            worker_timeout_seconds=min(
                                120.0,
                                self.config.prompt_chat_timeout_seconds,
                            ),
                            zero_index_ready_waiter=wait_for_qwen_ready,
                        )
                failure_stage = "validating-reply"
                reply = self._prompt_chat_reply(result)
                output_tokens = self._prompt_chat_output_tokens(result)
                if output_tokens > int(provider_payload["max_tokens"]):
                    raise RuntimeError("Qwen Prompt Editor exceeded its output-token limit.")
                failure_stage = "settling-credit"
                with self.connection() as db:
                    now = int(time.time())
                    charged_credits, balance = self._settle_prompt_chat_credit(
                        db,
                        license_row,
                        request_id,
                        output_tokens,
                        now,
                    )
                return {
                    "reply": reply,
                    "model": PROMPT_CHAT_MODEL_ID,
                    "credits_charged": charged_credits,
                    "output_tokens": output_tokens,
                    "output_tokens_per_credit": PROMPT_CHAT_OUTPUT_TOKENS_PER_CREDIT,
                    "available_credits": balance,
                    "privacy": "conversation content is forwarded for inference and is not stored by the KREA2 gateway",
                }
        except asyncio.CancelledError:
            if reserved:
                with self.connection() as db:
                    self._refund_prompt_chat_credit(db, license_row, request_id, int(time.time()))
            raise
        except HTTPException:
            if reserved:
                with self.connection() as db:
                    self._refund_prompt_chat_credit(db, license_row, request_id, int(time.time()))
            raise
        except Exception as exc:
            if reserved:
                with self.connection() as db:
                    self._refund_prompt_chat_credit(db, license_row, request_id, int(time.time()))
            safe_error = redact_error_report_text(
                f"{type(exc).__name__}: {exc}", 1200
            ).replace("\n", " ")
            LOGGER.error(
                "Prompt Editor request %s failed during %s: %s",
                request_id[:12],
                failure_stage,
                safe_error,
            )
            raise HTTPException(503, "Qwen Prompt Editor is warming or temporarily unavailable; no credit was charged.") from exc

    def _prune_prompt_chat_runs(self) -> None:
        cutoff = time.monotonic() - PROMPT_CHAT_RESULT_TTL_SECONDS
        stale = [
            request_id
            for request_id, run in self._prompt_chat_runs.items()
            if run.get("finished_monotonic") is not None
            and float(run["finished_monotonic"]) < cutoff
        ]
        for request_id in stale:
            self._prompt_chat_runs.pop(request_id, None)

    async def _run_prompt_chat_job(
        self,
        payload: PromptChatRequest,
        license_row: sqlite3.Row,
        request_id: str,
    ) -> None:
        run = self._prompt_chat_runs.get(request_id)
        if run is None:
            return
        run["status"] = "running"
        try:
            run["result"] = await self.prompt_chat(payload, license_row, request_id)
            run["status"] = "completed"
        except HTTPException as exc:
            run["status"] = "error"
            run["error_status"] = int(exc.status_code)
            run["error_detail"] = str(exc.detail)
        except Exception:
            run["status"] = "error"
            run["error_status"] = 503
            run["error_detail"] = "Qwen Prompt Editor is temporarily unavailable; no credit was charged."
        finally:
            run["finished_monotonic"] = time.monotonic()
            # Drop the task reference after completion. The response remains
            # available in memory for bounded polling/retry recovery.
            run.pop("task", None)

    async def submit_prompt_chat(
        self,
        payload: PromptChatRequest,
        license_row: sqlite3.Row,
        request_id: str,
    ) -> dict[str, Any]:
        if payload.model != PROMPT_CHAT_MODEL_ID or payload.stream:
            raise HTTPException(422, "Only the pinned Qwen 3.8 Prompt Editor model is available.")
        prompt_chat_api_key = self.config.prompt_chat_api_key
        if (
            not self.dedicated_configured()
            and (
                not self.config.prompt_chat_endpoint
                or len(prompt_chat_api_key) < 24
                or CoroutineServerless is None
            )
        ):
            raise HTTPException(503, "Qwen Prompt Editor is not configured.")
        self._prompt_chat_content(payload)
        self._prune_prompt_chat_runs()
        license_id = str(license_row["license_id"])
        existing = self._prompt_chat_runs.get(request_id)
        if existing is not None:
            if not hmac.compare_digest(str(existing["license_id"]), license_id):
                raise HTTPException(409, "Prompt Editor request ownership is invalid.")
            return {
                "request_id": request_id,
                "status": str(existing["status"]),
                "credits_charged": 0,
            }
        with self.connection() as db:
            if db.execute("SELECT 1 FROM prompt_chat_jobs WHERE request_id=?", (request_id,)).fetchone():
                raise HTTPException(409, "Prompt Editor request ID was already used. Send the message again.")
            self._grant_welcome_credits(db, str(license_row["discord_user_id"]), int(time.time()))
            if self._account_balance(db, str(license_row["discord_user_id"])) < PROMPT_CHAT_CREDIT_COST:
                raise HTTPException(402, "Prompt Editor credits are exhausted. Purchase a Bitcoin credit pack.")
        run: dict[str, Any] = {
            "license_id": license_id,
            "status": "queued",
            "created_monotonic": time.monotonic(),
            "finished_monotonic": None,
        }
        self._prompt_chat_runs[request_id] = run
        run["task"] = asyncio.create_task(self._run_prompt_chat_job(payload, license_row, request_id))
        return {"request_id": request_id, "status": "queued", "credits_charged": 0}

    def prompt_chat_job(
        self,
        license_row: sqlite3.Row,
        request_id: str,
    ) -> dict[str, Any]:
        self._prune_prompt_chat_runs()
        run = self._prompt_chat_runs.get(request_id)
        if run is None:
            raise HTTPException(404, "Prompt Editor job was not found or has expired; no new credit was charged.")
        if not hmac.compare_digest(str(run["license_id"]), str(license_row["license_id"])):
            raise HTTPException(404, "Prompt Editor job was not found or has expired; no new credit was charged.")
        status = str(run["status"])
        if status == "error":
            raise HTTPException(int(run.get("error_status") or 503), str(run.get("error_detail") or "Prompt Editor failed."))
        if status != "completed":
            return {"request_id": request_id, "status": status, "credits_charged": 0}
        result = dict(run.get("result") or {})
        result.update({"request_id": request_id, "status": "completed"})
        return result

    async def infer(self, payload: ChatRequest, license_row: sqlite3.Row, request_id: str) -> dict[str, Any]:
        if payload.model != MODEL_ID or payload.stream:
            raise HTTPException(422, "Only the pinned KREA2 remote Gemma model is available.")
        if len(json.dumps(payload.model_dump(), separators=(",", ":")).encode("utf-8")) > self.config.max_request_bytes:
            raise HTTPException(413, "The remote Vision request is too large.")
        if (
            not self.dedicated_configured()
            and (
                not self.config.vast_endpoint
                or len(self.config.vast_api_key) < 24
            )
        ):
            raise HTTPException(503, "The remote Vision service is not configured.")
        if not self.dedicated_configured() and CoroutineServerless is None:
            raise HTTPException(503, "The remote Vision SDK is not installed.")
        request_payload = payload.model_dump(exclude_none=True)
        request_digest = hashlib.sha256(
            json.dumps(
                request_payload,
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        # Reject a replay before querying or waking any remote GPU.  The credit
        # reservation repeats this check inside its transaction to close the
        # race between this no-wake preflight and final route admission.
        with self.connection() as db:
            self._release_stale_reservations(db, int(time.time()))
            self._assert_unused_request_id(
                db, license_row, request_id, request_digest
            )
            self._preflight_credit_balance(db, license_row)
        if self.dedicated_configured():
            reservation_owned = False
            try:
                with self.connection() as db:
                    now = int(time.time())
                    self._release_stale_reservations(db, now)
                    reservation_owned = self._reserve_image_credits(
                        db, license_row, request_id, request_digest, now
                    )
                result = await self._dedicated_completion(
                    request_payload,
                    model=MODEL_ID,
                    timeout_seconds=self.config.request_timeout_seconds,
                )
                choices = result.get("choices")
                first_message = (
                    choices[0].get("message")
                    if isinstance(choices, list)
                    and choices
                    and isinstance(choices[0], dict)
                    else None
                )
                content = (
                    first_message.get("content")
                    or first_message.get("reasoning_content")
                    if isinstance(first_message, dict)
                    else None
                )
                if not isinstance(content, str) or not content.strip():
                    raise RuntimeError(
                        "Dedicated Vision returned an empty completion"
                    )
                return result
            except asyncio.CancelledError:
                if reservation_owned:
                    with self.connection() as db:
                        self._release_image_credits(
                            db, license_row, request_id, int(time.time())
                        )
                raise
            except Exception as exc:
                if reservation_owned:
                    with self.connection() as db:
                        self._release_image_credits(
                            db, license_row, request_id, int(time.time())
                        )
                raise HTTPException(
                    503,
                    "Dedicated Vision is warming or temporarily unavailable; reserved credits were refunded.",
                ) from exc
        self._instance_readiness_until = 0.0
        readiness = await self.remote_readiness()
        self._require_remote_capacity(readiness)
        # The image's own route is the cold-worker wake signal. Do not issue a
        # redundant text probe first: that doubled cold latency and, worse,
        # waiting for READY before creating a route could never wake an inactive
        # worker. ``admit_after_route`` below reserves credits only after this
        # exact image route is READY and scale-to-zero has been restored.
        reserved = False
        reservation_owned = False
        result: dict[str, Any] | None = None
        last_activation_error: Exception | None = None
        try:
            route_deadline = min(
                self.config.request_timeout_seconds,
                self.config.activation_deadline_seconds,
            )
            async with self._activation_lock:
                # The request may have waited behind another image. Repeat every
                # no-wake preflight inside the FIFO lock so a newly exhausted
                # balance, replayed request ID, or changed GPU pool cannot spend
                # provider time using stale state.
                with self.connection() as db:
                    self._release_stale_reservations(db, int(time.time()))
                    self._assert_unused_request_id(
                        db, license_row, request_id, request_digest
                    )
                    self._preflight_credit_balance(db, license_row)
                self._instance_readiness_until = 0.0
                readiness = await self.remote_readiness()
                self._require_remote_capacity(readiness)
                candidates: set[int] = set()
                if (
                    int(readiness.get("ready_workers") or 0) == 0
                    and int(readiness.get("inactive_workers") or 0) == 1
                    and int(readiness.get("starting_workers") or 0) == 0
                    and int(readiness.get("worker_count") or 0) == 1
                ):
                    candidates = await asyncio.to_thread(
                        self._prepared_activation_machine_ids
                    )
                activation_expires = time.monotonic() + route_deadline
                for activation_attempt in range(2):
                    if time.monotonic() >= activation_expires:
                        break
                    floor_restored = False
                    floor_reset_required = True
                    activation_phase = "floor-up"
                    try:
                        await self._set_activation_floor_async(1.0)
                        activation_phase = "route"
                        async with CoroutineServerless(
                            api_key=self.config.vast_api_key,
                            default_request_timeout=max(
                                route_deadline,
                                self.config.inference_deadline_seconds,
                            ),
                        ) as client:
                            endpoint = await client.get_endpoint(self.config.vast_endpoint)

                            async def admit_after_route() -> None:
                                nonlocal activation_phase, floor_restored, reservation_owned, reserved
                                activation_phase = "post-route-policy"
                                self._instance_readiness_until = 0.0
                                routed_readiness = await self.remote_readiness()
                                self._require_remote_capacity(
                                    routed_readiness, require_ready=True
                                )
                                activation_phase = "floor-down"
                                await self._restore_activation_floor()
                                floor_restored = True
                                activation_phase = "credit-reservation"
                                with self.connection() as db:
                                    now = int(time.time())
                                    self._release_stale_reservations(db, now)
                                    reservation_owned = self._reserve_image_credits(
                                        db, license_row, request_id, request_digest, now
                                    )
                                reserved = True
                                activation_phase = "inference"

                            result = await self._fast_routed_request(
                                client,
                                endpoint,
                                request_payload,
                                activation_expires,
                                # This is scheduling load, not an output-token limit.
                                # A single prompt must not recruit several GPUs.
                                cost=min(payload.max_tokens, 100),
                                before_send=admit_after_route,
                                worker_timeout_seconds=self.config.inference_deadline_seconds,
                            )
                        break
                    except asyncio.CancelledError:
                        raise
                    except HTTPException:
                        raise
                    except Exception as exc:
                        last_activation_error = exc
                        if reserved:
                            raise
                    finally:
                        if floor_reset_required and not floor_restored:
                            await self._restore_activation_floor()
                            floor_restored = True

                    if activation_attempt == 1:
                        break

                    # Route/controller failures do not identify a bad machine.
                    # Retry the now-warm admission once without mutating the
                    # deny-list; evidence-based health reconciliation owns GPU
                    # quarantine.
                    self._recovery_status = "activation-retrying"
                    remaining = activation_expires - time.monotonic()
                    if remaining <= 0.25:
                        break
                    await asyncio.sleep(min(2.0, remaining))

                if result is None:
                    # Attribute an unreserved route failure only when the exact
                    # single stopped standby is still present and the controller
                    # remains freshly policy-clean after floor=0 was confirmed.
                    # Two distinct image IDs are required before quarantine.
                    evidence_clean = False
                    try:
                        self._instance_readiness_until = 0.0
                        failed_readiness = await self.remote_readiness()
                        self._require_remote_capacity(failed_readiness)
                        exact_single_standby = bool(
                            len(candidates) == 1
                            and int(failed_readiness.get("ready_workers") or 0) == 0
                            and int(failed_readiness.get("inactive_workers") or 0) == 1
                            and int(failed_readiness.get("starting_workers") or 0) == 0
                            and int(failed_readiness.get("worker_count") or 0) == 1
                        )
                        if exact_single_standby:
                            failed_candidates = await asyncio.to_thread(
                                self._prepared_activation_machine_ids
                            )
                            evidence_clean = failed_candidates == candidates
                    except Exception:
                        evidence_clean = False
                    if evidence_clean and self._record_activation_failure(
                        candidates, request_id
                    ):
                        try:
                            quarantined = await asyncio.to_thread(
                                self._replace_failed_activation_workers,
                                candidates,
                            )
                        except Exception:
                            quarantined = set()
                        if quarantined:
                            raise HTTPException(
                                503,
                                "The repeatedly failing remote standby was quarantined and an approved replacement is being prepared; no credits were reserved. Retry shortly or use Local GPU.",
                            )
                    raise last_activation_error or TimeoutError("Remote route did not become ready")
                self._record_activation_success(candidates)
        except asyncio.CancelledError:
            if reservation_owned:
                with self.connection() as db:
                    self._release_image_credits(db, license_row, request_id, int(time.time()))
            self._instance_readiness_until = 0.0
            raise
        except HTTPException:
            raise
        except Exception as exc:
            self._instance_readiness_until = 0.0
            if not reserved:
                raise HTTPException(
                    503,
                    "Remote GPU activation and its one automatic recovery attempt did not complete; no credits were reserved.",
                ) from exc
            raise HTTPException(
                503,
                f"Remote GPU did not complete within the {int(self.config.inference_deadline_seconds)}-second inference limit after routing; the image reservation is awaiting the pipeline's final charge-or-refund decision.",
            ) from exc
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise HTTPException(
                503,
                "Remote GPU transport did not return a usable result; the image reservation is awaiting the pipeline's final charge-or-refund decision.",
            )
        nested = result.get("response")
        if isinstance(nested, str):
            try: nested = json.loads(nested)
            except json.JSONDecodeError as exc: raise HTTPException(502, "Remote Vision returned invalid JSON.") from exc
        choices = nested.get("choices") if isinstance(nested, dict) else None
        first_message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        content = (
            first_message.get("content") or first_message.get("reasoning_content")
            if isinstance(first_message, dict)
            else None
        )
        if not isinstance(nested, dict) or not isinstance(content, str) or not content.strip():
            raise HTTPException(
                503,
                "Remote GPU did not return a usable result; the image reservation is awaiting the pipeline's final charge-or-refund decision.",
            )
        return nested

    def complete_audit(self, payload: AuditCompletion, license_row: sqlite3.Row, request_id: str) -> None:
        if payload.model_id != PUBLIC_MODEL_ID:
            raise HTTPException(422, "The remote model proof is invalid.")
        if len(payload.prompt_variants) not in {1,3}:
            raise HTTPException(422, "The remote prompt proof must contain one prompt or exactly three variations.")
        variants = [clean_text(item, 8000) for item in payload.prompt_variants]
        if any(len(item) < 1200 for item in variants):
            raise HTTPException(422, "The remote prompt proof is incomplete.")
        source_url = payload.source_url.strip()
        if source_url and not SOURCE_URL_RE.fullmatch(source_url):
            raise HTTPException(422, "The source reference is not an allowed Discord attachment URL.")
        with self.connection() as db:
            job = db.execute("SELECT * FROM remote_jobs WHERE request_id=?", (request_id,)).fetchone()
            if not job or job["license_id"] != license_row["license_id"]:
                raise HTTPException(404, "The remote request record was not found.")
            if job["completed_at"] is not None:
                return
            if job["credit_state"] == "refunded":
                raise HTTPException(409, "A refunded remote image cannot be marked complete.")
            now = int(time.time())
            if job["credit_state"] == "reserved":
                db.execute("UPDATE remote_jobs SET credit_state='charged' WHERE request_id=?", (request_id,))
            db.execute("UPDATE remote_jobs SET completed_at=?, source_url=?, prompt_variants_json=? WHERE request_id=?", (now, source_url or None, json.dumps(variants, ensure_ascii=False), request_id))
        self._post_webhook(license_row, request_id, source_url, variants)
        self.prune_audits()

    def fail_audit(self, license_row: sqlite3.Row, request_id: str) -> None:
        with self.connection() as db:
            self._release_image_credits(db, license_row, request_id, int(time.time()))

    def create_credit_invoice(self, license_row: sqlite3.Row, pack_id: str) -> dict[str, str | int | bool]:
        if not self.btcpay_configured():
            raise HTTPException(503, "Bitcoin credit purchases are not configured yet. Local GPU remains free.")
        definition = CREDIT_PACKS.get(pack_id)
        if definition is None:
            raise HTTPException(422, "The requested credit pack is invalid.")
        discord_user_id = str(license_row["discord_user_id"])
        credits = int(definition["credits"])
        price_usd = str(definition["price_usd"])
        with self._credit_purchase_lock:
            self._reconcile_credit_invoices(discord_user_id)
            with self.connection() as db:
                intro_used = self._intro_pack_used(db, discord_user_id)
                if pack_id == INTRO_CREDIT_PACK_ID and intro_used:
                    raise HTTPException(
                        409,
                        "The one-time $1.50 starter pack has already been purchased. Choose a $5, $10, or $20 pack.",
                    )
                if pack_id != INTRO_CREDIT_PACK_ID and not intro_used:
                    raise HTTPException(
                        409,
                        "The one-time $1.50 starter pack is the first-purchase offer. Complete it before choosing a regular pack.",
                    )
                existing = db.execute(
                    "SELECT * FROM credit_invoices WHERE discord_user_id=? AND pack_id=? AND status='new' ORDER BY created_at DESC LIMIT 1",
                    (discord_user_id, pack_id),
                ).fetchone()
                if existing:
                    return {
                        "invoice_id": str(existing["invoice_id"]),
                        "checkout_url": str(existing["checkout_url"]),
                        "pack_id": pack_id,
                        "credits": int(existing["credits"]),
                        "price_usd": str(existing["amount"]),
                        "reused": True,
                    }

            now = int(time.time())
            purchase_reference = f"krea2-{pack_id}-" + secrets.token_urlsafe(18)
            try:
                response = self.http.post(
                    f"{self.config.btcpay_url}/api/v1/stores/{self.config.btcpay_store_id}/invoices",
                    headers={"Authorization": f"token {self.config.btcpay_api_key}", "Content-Type": "application/json"},
                    json={
                        "amount": price_usd,
                        "currency": "USD",
                        "metadata": {
                            "orderId": purchase_reference,
                            "itemCode": self._credit_pack_item_code(pack_id),
                        },
                        "checkout": {"redirectAutomatically": False},
                    },
                    timeout=15,
                )
                body = response.json()
                invoice_id = str(body.get("id") or "")
                checkout_url = str(body.get("checkoutLink") or "")
                if getattr(response, "status_code", 500) >= 400 or not invoice_id or not checkout_url.startswith("https://"):
                    raise ValueError("BTCPay did not return a valid checkout")
            except Exception as exc:
                raise HTTPException(503, "Bitcoin checkout is temporarily unavailable. Retry shortly.") from exc
            with self.connection() as db:
                db.execute(
                    "INSERT INTO credit_invoices(invoice_id,purchase_reference,discord_user_id,license_id,pack_id,credits,amount,currency,checkout_url,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        invoice_id,
                        purchase_reference,
                        discord_user_id,
                        license_row["license_id"],
                        pack_id,
                        credits,
                        price_usd,
                        "USD",
                        checkout_url,
                        "new",
                        now,
                    ),
                )
        return {
            "invoice_id": invoice_id,
            "checkout_url": checkout_url,
            "pack_id": pack_id,
            "credits": credits,
            "price_usd": price_usd,
            "reused": False,
        }

    def _settle_credit_invoice_locked(
        self,
        db: sqlite3.Connection,
        invoice: sqlite3.Row,
        now: int,
    ) -> bool:
        if invoice["status"] == "settled":
            return False
        changed = db.execute(
            "UPDATE credit_invoices SET status='settled',settled_at=? WHERE invoice_id=? AND status!='settled'",
            (now, invoice["invoice_id"]),
        ).rowcount
        if changed != 1:
            return False
        self._grant_welcome_credits(db, str(invoice["discord_user_id"]), now)
        db.execute(
            "UPDATE credit_accounts SET available_credits=available_credits+?,updated_at=? WHERE discord_user_id=?",
            (int(invoice["credits"]), now, invoice["discord_user_id"]),
        )
        db.execute(
            "INSERT INTO credit_ledger(discord_user_id,delta_credits,entry_kind,invoice_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)",
            (
                invoice["discord_user_id"],
                int(invoice["credits"]),
                "bitcoin_purchase",
                invoice["invoice_id"],
                f"invoice:{invoice['invoice_id']}",
                now,
            ),
        )
        return True

    def _reconcile_credit_invoices(self, discord_user_id: str) -> None:
        """Settle pending packs from BTCPay during the plugin's balance polling.

        The signed webhook remains the fast path. This authenticated fallback
        keeps checkout reliable when a store administrator has not yet granted
        this product permission to create its own webhook.
        """

        if not self.btcpay_configured():
            return
        with self.connection() as db:
            pending = db.execute(
                "SELECT * FROM credit_invoices WHERE discord_user_id=? AND status='new' ORDER BY created_at DESC LIMIT 4",
                (discord_user_id,),
            ).fetchall()
        for invoice in pending:
            try:
                response = self.http.get(
                    f"{self.config.btcpay_url}/api/v1/invoices/{invoice['invoice_id']}",
                    headers={"Authorization": f"token {self.config.btcpay_api_key}"},
                    timeout=10,
                )
                document = response.json()
                if getattr(response, "status_code", 500) != 200 or not isinstance(document, dict):
                    continue
                metadata = document.get("metadata")
                try:
                    amount_matches = Decimal(str(document.get("amount"))) == Decimal(str(invoice["amount"]))
                except (InvalidOperation, TypeError, ValueError):
                    amount_matches = False
                pack_id = str(invoice["pack_id"] or INTRO_CREDIT_PACK_ID)
                accepted_item_codes = {self._credit_pack_item_code(pack_id)}
                if pack_id == INTRO_CREDIT_PACK_ID:
                    # Existing unpaid starter invoices used this legacy code.
                    accepted_item_codes.add("krea2-credits-1200")
                if not (
                    str(document.get("id") or "") == str(invoice["invoice_id"])
                    and str(document.get("storeId") or "") == self.config.btcpay_store_id
                    and str(document.get("currency") or "").upper() == str(invoice["currency"]).upper()
                    and amount_matches
                    and isinstance(metadata, dict)
                    and str(metadata.get("orderId") or "") == str(invoice["purchase_reference"])
                    and str(metadata.get("itemCode") or "") in accepted_item_codes
                ):
                    LOGGER.error("BTCPay invoice %s failed KREA2 settlement verification", str(invoice["invoice_id"])[:12])
                    continue
                status = str(document.get("status") or "")
                with self.connection() as db:
                    current = db.execute(
                        "SELECT * FROM credit_invoices WHERE invoice_id=?",
                        (invoice["invoice_id"],),
                    ).fetchone()
                    if not current:
                        continue
                    if status == "Settled":
                        self._settle_credit_invoice_locked(db, current, int(time.time()))
                    elif status in {"Expired", "Invalid"}:
                        db.execute(
                            "UPDATE credit_invoices SET status=? WHERE invoice_id=? AND status='new'",
                            (status.lower(), invoice["invoice_id"]),
                        )
            except Exception as exc:
                LOGGER.warning(
                    "BTCPay invoice reconciliation deferred for %s: %s",
                    str(invoice["invoice_id"])[:12],
                    type(exc).__name__,
                )

    def accept_btcpay_webhook(self, raw_body: bytes, signature: str | None) -> None:
        if not self.btcpay_configured():
            raise HTTPException(503, "Bitcoin webhook is not configured.")
        expected = "sha256=" + hmac.new(self.config.btcpay_webhook_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        if not signature or not hmac.compare_digest(expected, signature):
            raise HTTPException(401, "BTCPay webhook signature is invalid.")
        try:
            event = json.loads(raw_body.decode("utf-8"))
            delivery_id, event_type = str(event.get("deliveryId") or ""), str(event.get("type") or "")
            invoice_id, store_id = str(event.get("invoiceId") or ""), str(event.get("storeId") or "")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(422, "BTCPay webhook payload is invalid.") from exc
        if not delivery_id or not invoice_id or store_id != self.config.btcpay_store_id:
            raise HTTPException(422, "BTCPay webhook payload is invalid.")
        with self.connection() as db:
            if not db.execute("INSERT OR IGNORE INTO btcpay_webhook_deliveries(delivery_id,received_at) VALUES(?,?)", (delivery_id, int(time.time()))).rowcount:
                return
            if event_type != "InvoiceSettled":
                return
            invoice = db.execute("SELECT * FROM credit_invoices WHERE invoice_id=?", (invoice_id,)).fetchone()
            if not invoice:
                return
            self._settle_credit_invoice_locked(db, invoice, int(time.time()))

    def _post_webhook(self, license_row: sqlite3.Row, request_id: str, source_url: str, variants: list[str]) -> None:
        if not self.config.audit_webhook_url:
            return
        preview = "\n\n".join(f"Prompt {index + 1}: {value[:420]}" for index, value in enumerate(variants))
        content = f"**KREA2 remote Vision completed**\nDiscord: `{license_row['discord_username']}` (`{license_row['discord_user_id']}`)\nLicense: `{license_row['license_id']}`\nModel: `{PUBLIC_MODEL_ID}`\nRequest: `{request_id}`\n" + (f"Source: <{source_url}>\n" if source_url else "Source: not provided\n") + "\n" + preview[:1200]
        try: self.http.post(self.config.audit_webhook_url, json={"content": content[:1900], "allowed_mentions": {"parse": []}}, timeout=8)
        except Exception: return

    def post_error_webhook(self, payload: DiscordErrorReport, license_row: sqlite3.Row) -> dict[str, bool]:
        """Post one redacted text attachment per failed image without charging credits."""

        if not self.config.audit_webhook_url:
            raise HTTPException(503, "Discord error webhook is not configured.")
        now = time.monotonic()
        license_id = str(license_row["license_id"])
        with self._error_report_lock:
            self._error_report_seen = {
                key: created for key, created in self._error_report_seen.items()
                if now - created < 900
            }
            recent = [created for created in self._error_report_rate.get(license_id, []) if now - created < 600]
            if payload.event_id in self._error_report_seen:
                return {"accepted": True, "duplicate": True}
            if len(recent) >= 30:
                raise HTTPException(429, "Discord error reporting is temporarily rate limited.")
            recent.append(now)
            self._error_report_rate[license_id] = recent
            # Reserve before transport so simultaneous plugin/backend failures
            # cannot flood the webhook. A failed transport releases the key.
            self._error_report_seen[payload.event_id] = now

        fields = {
            "event_id": payload.event_id,
            "model_id": clean_text(payload.model_id, 200),
            "pipeline_id": clean_text(payload.pipeline_id, 200),
            "error_code": clean_text(payload.error_code, 80),
            "error_message": redact_error_report_text(payload.error_message, 2000),
            "stage": redact_error_report_text(payload.stage, 200),
            "runtime": clean_text(payload.runtime, 40),
            "plugin_version": clean_text(payload.plugin_version, 40),
            "backend_version": clean_text(payload.backend_version, 40),
        }
        report = "\n".join(
            [
                "KREA2 Vision Error Report",
                "=========================",
                f"Generated UTC: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
                *(f"{key}: {value}" for key, value in fields.items()),
                "",
                "Redaction: image bytes, prompts, Discord identity, credentials, URLs, filenames, and local user paths are excluded.",
                "",
                "Technical exception chain",
                "-------------------------",
                redact_error_report_text(payload.technical_trace),
                "",
            ]
        ).encode("utf-8")
        filename = f"krea2-vision-error-{payload.event_id[:12]}.txt"
        summary = (
            "**KREA2 Vision error report**\n"
            f"Event: `{payload.event_id}`\n"
            f"Stage: `{fields['stage'][:160]}`\n"
            f"Model: `{fields['model_id'][:160]}`"
        )
        try:
            response = self.http.post(
                self.config.audit_webhook_url,
                data={
                    "payload_json": json.dumps(
                        {"content": summary[:1900], "allowed_mentions": {"parse": []}},
                        separators=(",", ":"),
                    )
                },
                files={"files[0]": (filename, report, "text/plain; charset=utf-8")},
                timeout=8,
                allow_redirects=False,
            )
            if response.status_code not in {200, 204}:
                raise RuntimeError(f"Discord webhook returned HTTP {response.status_code}.")
        except Exception as exc:
            with self._error_report_lock:
                self._error_report_seen.pop(payload.event_id, None)
            raise HTTPException(503, "Discord error webhook could not accept the report.") from exc
        return {"accepted": True, "duplicate": False}

    def prune_audits(self) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM remote_jobs WHERE completed_at IS NOT NULL AND completed_at < ?", (int(time.time()) - self.config.retention_days * 86400,))

    def revoke(self, license_id: str, reason: str) -> None:
        if not LICENSE_ID_RE.fullmatch(license_id):
            raise HTTPException(422, "License ID is invalid.")
        with self.connection() as db:
            changed = db.execute("UPDATE licenses SET status='revoked', revoked_at=?, revoked_reason=? WHERE license_id=?", (int(time.time()), clean_text(reason, 240), license_id)).rowcount
        if not changed: raise HTTPException(404, "License was not found.")


def create_app(config: Config | None = None, *, http: Any = requests) -> FastAPI:
    gateway = Gateway(config or Config.from_env(), http=http)
    app = FastAPI(title="KREA2 Vision Remote Gateway", docs_url=None, redoc_url=None)
    app.state.gateway = gateway

    @app.get("/health")
    async def health() -> dict[str, Any]:
        remote = await gateway.remote_readiness()
        activation_elapsed = gateway._activation_last_elapsed_seconds
        if gateway._activation_started_at:
            activation_elapsed = max(
                0.0, time.monotonic() - gateway._activation_started_at
            )
        return {
            "ok": True, "model": PUBLIC_MODEL_ID,
            "configured": remote["configured"],
            "remote_ready": bool(remote["ready_workers"]),
            "remote_cold_start_eligible": bool(remote["cold_start_eligible"]),
            "remote_worker_count": remote["worker_count"],
            "remote_workergroup_attached": remote["workergroup_attached"],
            "remote_controller_verified": bool(remote.get("controller_verified")),
            "remote_status": remote["reason"] or "Remote GPU ready.",
            "remote_starting_workers": int(remote.get("starting_workers") or 0),
            "remote_unhealthy_workers": int(remote.get("unhealthy_workers") or 0),
            "remote_inactive_workers": int(remote.get("inactive_workers") or 0),
            "remote_disallowed_workers": int(remote.get("disallowed_workers") or 0),
            "remote_recovery_status": str(remote.get("recovery_status") or gateway._recovery_status),
            "remote_queue_depth": int(remote.get("queue_depth") or 0),
            "remote_activation_phase": gateway._activation_phase,
            "remote_activation_elapsed_seconds": round(activation_elapsed, 3),
            "remote_activation_last_outcome": gateway._activation_last_outcome,
            "remote_bootstrap_deadline_seconds": int(gateway.config.bootstrap_deadline_seconds),
            "remote_activation_deadline_seconds": int(gateway.config.activation_deadline_seconds),
            "remote_inference_deadline_seconds": int(gateway.config.inference_deadline_seconds),
            "remote_allowed_gpu_names": list(gateway.config.allowed_gpu_names),
            "remote_max_worker_hourly_usd": gateway.config.max_worker_hourly_usd,
            "discord_oauth_configured": gateway.oauth_configured(),
            "bitcoin_credits_configured": gateway.btcpay_configured(),
        }

    def authorize_openwebui(authorization: str | None) -> None:
        supplied = ""
        if isinstance(authorization, str) and authorization.lower().startswith("bearer "):
            supplied = authorization[7:].strip()
        expected = gateway.config.openwebui_bridge_api_key
        if len(expected) < 24 or not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, "OpenWebUI bridge authorization failed.")

    @app.get("/v1/openwebui/models")
    async def openwebui_models(
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        authorize_openwebui(authorization)
        if not gateway.dedicated_configured():
            raise HTTPException(503, "Dedicated Qwen is not configured.")
        return {
            "object": "list",
            "data": [
                {
                    "id": PROMPT_CHAT_MODEL_ID,
                    "object": "model",
                    "created": 0,
                    "owned_by": "krea2-dedicated",
                }
            ],
        }

    @app.post("/v1/openwebui/chat/completions")
    async def openwebui_chat(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        authorize_openwebui(authorization)
        if not gateway.dedicated_configured():
            raise HTTPException(503, "Dedicated Qwen is not configured.")
        raw_body = await request.body()
        if len(raw_body) > 4 * 1024 * 1024:
            raise HTTPException(413, "OpenWebUI request is too large.")
        try:
            payload = json.loads(raw_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(400, "OpenWebUI request body is invalid JSON.") from exc
        messages = payload.get("messages") if isinstance(payload, dict) else None
        if not isinstance(messages, list) or not messages:
            raise HTTPException(422, "OpenWebUI messages must be a non-empty array.")
        try:
            return await gateway._dedicated_completion(
                payload,
                model=DEDICATED_QWEN_MODEL_ID,
                timeout_seconds=gateway.config.prompt_chat_timeout_seconds,
            )
        except RuntimeError as exc:
            # Never let Starlette convert an upstream model rejection into a
            # plain-text 500. The local OpenWebUI bridge expects bounded JSON
            # and can then surface the failure accurately instead of claiming
            # the dedicated GPU returned malformed JSON.
            LOGGER.warning(
                "Dedicated OpenWebUI completion rejected after gateway validation: %s",
                type(exc).__name__,
            )
            raise HTTPException(
                502,
                "Dedicated Qwen rejected the normalized request. Retry once; if it persists, start a new chat.",
            ) from exc

    @app.post("/v1/admin/wake-proof")
    async def admin_wake_proof(
        x_krea2_admin_key: str | None = Header(
            default=None, alias="X-Krea2-Admin-Key"
        ),
    ) -> dict[str, Any]:
        """Run one tiny image-free model wake proof without app credit movement."""

        if (
            len(gateway.config.admin_key) < 32
            or not hmac.compare_digest(
                str(x_krea2_admin_key or ""), gateway.config.admin_key
            )
        ):
            raise HTTPException(403, "Administrative authorization failed.")

        def credit_aggregate() -> dict[str, int]:
            with gateway.connection() as db:
                account = db.execute(
                    "SELECT COALESCE(SUM(available_credits),0),COUNT(*) FROM credit_accounts"
                ).fetchone()
                return {
                    "available_credit_sum": int(account[0]),
                    "accounts": int(account[1]),
                    "jobs": int(
                        db.execute("SELECT COUNT(*) FROM remote_jobs").fetchone()[0]
                    ),
                    "ledger": int(
                        db.execute("SELECT COUNT(*) FROM credit_ledger").fetchone()[0]
                    ),
                }

        before = credit_aggregate()
        started = time.monotonic()
        # An empty maintenance request ID cannot contribute quarantine evidence.
        await gateway._ensure_remote_active("")
        elapsed = time.monotonic() - started
        after = credit_aggregate()
        if after != before:
            raise HTTPException(
                500,
                "The uncharged wake proof detected unexpected credit or job mutation.",
            )
        remote = await gateway.remote_readiness()
        return {
            "ok": True,
            "elapsed_seconds": round(elapsed, 3),
            "credit_state_unchanged": True,
            "remote_ready": bool(remote.get("ready_workers")),
            "remote_inactive_workers": int(remote.get("inactive_workers") or 0),
            "activation_outcome": gateway._activation_last_outcome,
            "activation_elapsed_seconds": round(
                gateway._activation_last_elapsed_seconds, 3
            ),
            "desired_floor": gateway._desired_activation_floor,
            "headroom_target": gateway._activation_headroom_target,
        }

    @app.post("/v1/oauth/start")
    def oauth_start(payload: OAuthStartRequest) -> dict[str, str | int]:
        return gateway.start_oauth(payload)

    @app.get("/v1/oauth/status/{enrollment_id}")
    def oauth_status(enrollment_id: str, enrollment_secret: str | None = Header(default=None, alias="X-Krea2-Enrollment-Secret")) -> dict[str, str]:
        return gateway.oauth_status(enrollment_id, str(enrollment_secret or ""))

    @app.get("/v1/oauth/callback", response_class=HTMLResponse)
    def oauth_callback(state: str = Query(default=""), code: str = Query(default=""), error: str = Query(default="")) -> HTMLResponse:
        status, message = gateway.oauth_callback(state, code, error)
        safe = message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return HTMLResponse(f"<!doctype html><meta charset=utf-8><title>KREA2 Vision Suite</title><main><h1>KREA2 Vision Suite</h1><p>{safe}</p></main>", status_code=status, headers={"Cache-Control":"no-store"})

    @app.post("/v1/chat/completions")
    async def chat(payload: ChatRequest, authorization: str | None = Header(default=None), request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id")) -> dict[str, Any]:
        license_row = gateway.authenticate(authorization, request_id or "")
        return await gateway.infer(payload, license_row, request_id or "")

    @app.post("/v1/prompt-chat/completions")
    async def prompt_chat(
        payload: PromptChatRequest,
        authorization: str | None = Header(default=None),
        request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id"),
    ) -> dict[str, Any]:
        license_row = gateway.authenticate(authorization, request_id or "")
        return await gateway.prompt_chat(payload, license_row, request_id or "")

    @app.post("/v1/prompt-chat/jobs", status_code=202)
    async def submit_prompt_chat(
        payload: PromptChatRequest,
        authorization: str | None = Header(default=None),
        request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id"),
    ) -> dict[str, Any]:
        license_row = gateway.authenticate(authorization, request_id or "")
        return await gateway.submit_prompt_chat(payload, license_row, request_id or "")

    @app.get("/v1/prompt-chat/jobs/{request_id}")
    def prompt_chat_job(
        request_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        license_row = gateway.authenticate_license(authorization)
        if not REQUEST_ID_RE.fullmatch(request_id):
            raise HTTPException(422, "Prompt Editor request ID is invalid.")
        return gateway.prompt_chat_job(license_row, request_id)

    @app.post("/v1/audit/complete")
    def complete(payload: AuditCompletion, authorization: str | None = Header(default=None), request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id")) -> dict[str, bool]:
        license_row = gateway.authenticate(authorization, request_id or "")
        gateway.complete_audit(payload, license_row, request_id or "")
        return {"accepted": True}

    @app.post("/v1/audit/fail")
    def fail(authorization: str | None = Header(default=None), request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id")) -> dict[str, bool]:
        license_row = gateway.authenticate(authorization, request_id or "")
        gateway.fail_audit(license_row, request_id or "")
        return {"accepted": True}

    @app.post("/v1/audit/error")
    def error_report(payload: DiscordErrorReport, authorization: str | None = Header(default=None)) -> dict[str, bool]:
        license_row = gateway.authenticate_license(authorization)
        return gateway.post_error_webhook(payload, license_row)

    @app.get("/v1/credits/balance")
    def credit_balance(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        return gateway.credit_status(gateway.authenticate_license(authorization))

    @app.post("/v1/credits/purchase")
    def credit_purchase(payload: CreditPurchaseRequest, authorization: str | None = Header(default=None)) -> dict[str, str | int | bool]:
        if payload.confirmation == "buy-credit-pack" and payload.pack_id:
            pack_id = payload.pack_id
        elif payload.confirmation in {"", "buy-1200-credits"} and not payload.pack_id:
            # Backward compatibility for already-installed plugin builds.
            pack_id = INTRO_CREDIT_PACK_ID
        else:
            raise HTTPException(422, "The requested credit pack is invalid.")
        return gateway.create_credit_invoice(gateway.authenticate_license(authorization), pack_id)

    @app.post("/v1/btcpay/webhook")
    async def btcpay_webhook(request: Request, signature: str | None = Header(default=None, alias="BTCPay-Sig")) -> dict[str, bool]:
        gateway.accept_btcpay_webhook(await request.body(), signature)
        return {"accepted": True}

    @app.post("/v1/admin/licenses/{license_id}/revoke")
    def revoke(license_id: str, payload: RevokeRequest, admin_key: str | None = Header(default=None, alias="X-Krea2-Admin-Key")) -> dict[str, bool]:
        if len(gateway.config.admin_key) < 32 or not hmac.compare_digest(str(admin_key or ""), gateway.config.admin_key):
            raise HTTPException(401, "Administrator authorization failed.")
        gateway.revoke(license_id, payload.reason)
        return {"revoked": True}

    return app


app = create_app()
