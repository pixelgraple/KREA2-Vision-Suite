"""KREA2 remote-Vision gateway: license, audit, and secret-preserving inference."""

from __future__ import annotations

import base64
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
from urllib.parse import urlencode

import requests
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import HTMLResponse
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
ENROLLMENT_ID_RE = re.compile(r"^enr_[A-Za-z0-9_-]{24,96}$")
ENROLLMENT_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43,160}$")
OAUTH_STATE_RE = re.compile(r"^[A-Za-z0-9_-]{43,160}$")
OAUTH_ENROLLMENT_TTL_SECONDS = 10 * 60


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
            discord_client_id=os.getenv("KREA2_GATEWAY_DISCORD_CLIENT_ID", "").strip(),
            discord_client_secret=os.getenv("KREA2_GATEWAY_DISCORD_CLIENT_SECRET", ""),
            discord_redirect_uri=os.getenv("KREA2_GATEWAY_DISCORD_REDIRECT_URI", "").strip(),
            license_signing_key=os.getenv("KREA2_GATEWAY_LICENSE_SIGNING_KEY", ""),
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
            """)

            columns = {row[1] for row in db.execute("PRAGMA table_info(licenses)")}
            if "auth_method" not in columns:
                db.execute("ALTER TABLE licenses ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy_claim'")

    def oauth_configured(self) -> bool:
        return bool(
            re.fullmatch(r"[0-9]{17,22}", self.config.discord_client_id)
            and len(self.config.discord_client_secret) >= 24
            and self.config.discord_redirect_uri.startswith("https://")
            and len(self.config.license_signing_key) >= 32
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
        return {"status": "complete", "license_id": license_id, "license_token": token, "discord_username": clean_text(row["discord_username"], 80)}

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
            db.execute("UPDATE oauth_enrollments SET status='complete', completed_at=?, discord_user_id=?, discord_username=?, license_id=? WHERE enrollment_id=?", (now, user_id, username, license_id, enrollment["enrollment_id"]))
        return 200, "Discord account verified. You can close this page and return to KREA2 Vision Suite."

    def authenticate(self, authorization: str | None, request_id: str) -> sqlite3.Row:
        license_id, token = parse_bearer(authorization)
        if not REQUEST_ID_RE.fullmatch(request_id):
            raise HTTPException(422, "Remote request provenance is invalid.")
        with self.connection() as db:
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if not row or not hmac.compare_digest(row["token_digest"], token_hash(row["token_salt"], token)):
                raise HTTPException(401, "The remote KREA2 license is invalid.")
            if row["status"] != "active" or row["auth_method"] != "discord_oauth":
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
        return {
            "ok": True, "model": PUBLIC_MODEL_ID,
            "configured": bool(gateway.config.vast_endpoint and len(gateway.config.vast_api_key) >= 24),
            "discord_oauth_configured": gateway.oauth_configured(),
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

    @app.post("/v1/audit/complete")
    def complete(payload: AuditCompletion, authorization: str | None = Header(default=None), request_id: str | None = Header(default=None, alias="X-Krea2-Request-Id")) -> dict[str, bool]:
        license_row = gateway.authenticate(authorization, request_id or "")
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
