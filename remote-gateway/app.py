"""KREA2 remote-Vision gateway: license, audit, and secret-preserving inference."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
try:
    from vastai import CoroutineServerless
except ImportError:  # Allows isolated API-contract tests without the Vast SDK.
    CoroutineServerless = None

MODEL_ID = "gemma4-26b-a4b-heretic-q3-k-l"
PUBLIC_MODEL_ID = "vast::gemma4-26b-a4b-heretic-q3_k_l"
DISCORD_ID_RE = re.compile(r"^[1-9][0-9]{16,21}$")
LICENSE_ID_RE = re.compile(r"^lic_[A-Za-z0-9_-]{12,64}$")
REQUEST_ID_RE = re.compile(r"^[a-f0-9]{64}$")
SOURCE_URL_RE = re.compile(r"^https://(?:cdn\.discordapp\.com|media\.discordapp\.net)/attachments/[^\s?#]+(?:\?[^\s]*)?$", re.I)


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

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            database=Path(os.getenv("KREA2_GATEWAY_DB", "/data/krea2-vision-gateway/krea2-vision.sqlite3")),
            vast_endpoint=os.getenv("KREA2_GATEWAY_VAST_ENDPOINT", "").strip(),
            vast_api_key=os.getenv("KREA2_GATEWAY_VAST_API_KEY", ""),
            audit_webhook_url=os.getenv("KREA2_GATEWAY_AUDIT_WEBHOOK_URL", "").strip(),
            admin_key=os.getenv("KREA2_GATEWAY_ADMIN_KEY", ""),
            request_timeout_seconds=max(30.0, min(float(os.getenv("KREA2_GATEWAY_TIMEOUT_SECONDS", "1200")), 3600.0)),
            max_request_bytes=max(1_000_000, min(int(os.getenv("KREA2_GATEWAY_MAX_REQUEST_BYTES", str(12 * 1024 * 1024))), 24 * 1024 * 1024)),
            retention_days=max(1, min(int(os.getenv("KREA2_GATEWAY_AUDIT_RETENTION_DAYS", "30")), 365)),
        )


class ClaimRequest(BaseModel):
    discord_user_id: str = Field(min_length=17, max_length=22)
    discord_username: str = Field(min_length=1, max_length=80)
    installation_id: str = Field(min_length=24, max_length=128)


class ChatRequest(BaseModel):
    model: str
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=8)
    temperature: float = Field(ge=0, le=2)
    max_tokens: int = Field(ge=1, le=2048)
    stream: bool = False
    response_format: dict[str, Any] | None = None


class AuditCompletion(BaseModel):
    model_id: str
    prompt_variants: list[str] = Field(min_length=3, max_length=3)
    source_url: str = ""


class RevokeRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=240)


def clean_text(value: object, maximum: int) -> str:
    return " ".join(str(value or "").split())[:maximum]


def token_hash(salt: str, token: str) -> str:
    return hashlib.sha256((salt + "\0" + token).encode("utf-8")).hexdigest()


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
        config.database.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

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
                    status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),
                    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
                    revoked_at INTEGER, revoked_reason TEXT
                );
                CREATE INDEX IF NOT EXISTS licenses_user_idx ON licenses(discord_user_id);
                CREATE TABLE IF NOT EXISTS remote_jobs (
                    request_id TEXT PRIMARY KEY, license_id TEXT NOT NULL, model_id TEXT NOT NULL,
                    discord_user_id TEXT NOT NULL, discord_username TEXT NOT NULL,
                    started_at INTEGER NOT NULL, completed_at INTEGER, calls INTEGER NOT NULL DEFAULT 0,
                    source_url TEXT, prompt_variants_json TEXT
                );
                CREATE INDEX IF NOT EXISTS remote_jobs_retention_idx ON remote_jobs(completed_at);
            """)

    def claim(self, request: ClaimRequest) -> dict[str, str]:
        user_id = request.discord_user_id.strip()
        username = clean_text(request.discord_username, 80)
        install = request.installation_id.strip()
        if not DISCORD_ID_RE.fullmatch(user_id) or not username or not re.fullmatch(r"[A-Za-z0-9_-]{24,128}", install):
            raise HTTPException(422, "The Discord account claim is invalid.")
        now, salt, token = int(time.time()), secrets.token_hex(16), secrets.token_urlsafe(48)
        license_id = "lic_" + secrets.token_urlsafe(18).replace("-", "_")
        install_digest = hashlib.sha256(install.encode("utf-8")).hexdigest()
        with self.connection() as db:
            if db.execute("SELECT 1 FROM licenses WHERE discord_user_id=? AND status IN ('suspended','revoked') LIMIT 1", (user_id,)).fetchone():
                raise HTTPException(403, "Remote KREA2 API access is unavailable for this Discord account.")
            db.execute("UPDATE licenses SET status='suspended', revoked_at=?, revoked_reason='replaced after local reinstall' WHERE discord_user_id=? AND installation_digest=? AND status='active'", (now, user_id, install_digest))
            db.execute("INSERT INTO licenses VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)", (license_id, user_id, username, install_digest, salt, token_hash(salt, token), "active", now, now))
        return {"license_id": license_id, "license_token": token, "status": "active"}

    def authenticate(self, authorization: str | None, claimed_user_id: str, request_id: str) -> sqlite3.Row:
        license_id, token = parse_bearer(authorization)
        if not DISCORD_ID_RE.fullmatch(str(claimed_user_id or "")) or not REQUEST_ID_RE.fullmatch(request_id):
            raise HTTPException(422, "Remote request provenance is invalid.")
        with self.connection() as db:
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if not row or not hmac.compare_digest(row["token_digest"], token_hash(row["token_salt"], token)):
                raise HTTPException(401, "The remote KREA2 license is invalid.")
            if row["status"] != "active" or not hmac.compare_digest(row["discord_user_id"], claimed_user_id):
                raise HTTPException(403, "Remote KREA2 API access is unavailable for this Discord account.")
            db.execute("UPDATE licenses SET last_seen_at=? WHERE license_id=?", (int(time.time()), license_id))
            return row

    async def infer(self, payload: ChatRequest, license_row: sqlite3.Row, request_id: str) -> dict[str, Any]:
        if payload.model != MODEL_ID or payload.stream:
            raise HTTPException(422, "Only the pinned KREA2 remote Gemma model is available.")
        if len(json.dumps(payload.model_dump(), separators=(",", ":")).encode("utf-8")) > self.config.max_request_bytes:
            raise HTTPException(413, "The remote Vision request is too large.")
        if not self.config.vast_endpoint or len(self.config.vast_api_key) < 24:
            raise HTTPException(503, "The remote Vision service is not configured.")
        if CoroutineServerless is None:
            raise HTTPException(503, "The remote Vision SDK is not installed.")
        with self.connection() as db:
            db.execute("INSERT INTO remote_jobs(request_id,license_id,model_id,discord_user_id,discord_username,started_at,calls) VALUES(?,?,?,?,?,?,1) ON CONFLICT(request_id) DO UPDATE SET calls=calls+1", (request_id, license_row["license_id"], PUBLIC_MODEL_ID, license_row["discord_user_id"], license_row["discord_username"], int(time.time())))
        try:
            async with CoroutineServerless(api_key=self.config.vast_api_key, default_request_timeout=self.config.request_timeout_seconds) as client:
                endpoint = await client.get_endpoint(self.config.vast_endpoint)
                result = await endpoint.request("/v1/chat/completions", payload.model_dump(exclude_none=True), cost=payload.max_tokens, timeout=self.config.request_timeout_seconds, retry=True)
        except Exception as exc:
            raise HTTPException(503, "Remote GPU not available. Retry shortly.") from exc
        nested = result.get("response", result) if isinstance(result, dict) else None
        if isinstance(nested, str):
            try: nested = json.loads(nested)
            except json.JSONDecodeError as exc: raise HTTPException(502, "Remote Vision returned invalid JSON.") from exc
        if not isinstance(nested, dict) or nested.get("ok") is False:
            raise HTTPException(503, "Remote GPU not available. Retry shortly.")
        return nested

    def complete_audit(self, payload: AuditCompletion, license_row: sqlite3.Row, request_id: str) -> None:
        if payload.model_id != PUBLIC_MODEL_ID:
            raise HTTPException(422, "The remote model proof is invalid.")
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
            db.execute("UPDATE remote_jobs SET completed_at=?, source_url=?, prompt_variants_json=? WHERE request_id=?", (int(time.time()), source_url or None, json.dumps(variants, ensure_ascii=False), request_id))
        self._post_webhook(license_row, request_id, source_url, variants)
        self.prune_audits()

    def _post_webhook(self, license_row: sqlite3.Row, request_id: str, source_url: str, variants: list[str]) -> None:
        if not self.config.audit_webhook_url:
            return
        preview = "\n\n".join(f"Prompt {index + 1}: {value[:420]}" for index, value in enumerate(variants))
        content = f"**KREA2 remote Vision completed**\nDiscord: `{license_row['discord_username']}` (`{license_row['discord_user_id']}`)\nLicense: `{license_row['license_id']}`\nModel: `{PUBLIC_MODEL_ID}`\nRequest: `{request_id}`\n" + (f"Source: <{source_url}>\n" if source_url else "Source: not provided\n") + "\n" + preview[:1200]
        try: self.http.post(self.config.audit_webhook_url, json={"content": content[:1900], "allowed_mentions": {"parse": []}}, timeout=8)
        except Exception: return

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
    def health() -> dict[str, Any]:
        return {"ok": True, "model": PUBLIC_MODEL_ID, "configured": bool(gateway.config.vast_endpoint and len(gateway.config.vast_api_key) >= 24)}

    @app.post("/v1/licenses/claim")
    def claim(payload: ClaimRequest) -> dict[str, str]: return gateway.claim(payload)

    @app.post("/v1/chat/completions")
    async def chat(payload: ChatRequest, authorization: str | None = Header(default=None), discord_user_id: str | None = Header(default=None, alias="X-Krea2-Discord-User"), request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id")) -> dict[str, Any]:
        license_row = gateway.authenticate(authorization, discord_user_id or "", request_id or "")
        return await gateway.infer(payload, license_row, request_id or "")

    @app.post("/v1/audit/complete")
    def complete(payload: AuditCompletion, authorization: str | None = Header(default=None), discord_user_id: str | None = Header(default=None, alias="X-Krea2-Discord-User"), request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id")) -> dict[str, bool]:
        license_row = gateway.authenticate(authorization, discord_user_id or "", request_id or "")
        gateway.complete_audit(payload, license_row, request_id or "")
        return {"accepted": True}

    @app.post("/v1/admin/licenses/{license_id}/revoke")
    def revoke(license_id: str, payload: RevokeRequest, admin_key: str | None = Header(default=None, alias="X-Krea2-Admin-Key")) -> dict[str, bool]:
        if len(gateway.config.admin_key) < 32 or not hmac.compare_digest(str(admin_key or ""), gateway.config.admin_key):
            raise HTTPException(401, "Administrator authorization failed.")
        gateway.revoke(license_id, payload.reason)
        return {"revoked": True}

    return app


app = create_app()
