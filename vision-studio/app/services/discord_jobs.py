from __future__ import annotations

import re
import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .model_output import recover_prompt_value


ACTIVE_STATUSES = ("queued", "running")
TERMINAL_STATUSES = ("completed", "rejected", "error", "cancelled")
VALID_STATUSES = frozenset((*ACTIVE_STATUSES, *TERMINAL_STATUSES))
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
JOB_ID_RE = re.compile(r"^[a-f0-9]{32}$")


def _clean_text(value, maximum: int) -> str:
    return " ".join(str(value or "").split())[:maximum]


def _safe_filename(value) -> str:
    normalized = str(value or "").replace("\\", "/")
    return _clean_text(normalized.rsplit("/", 1)[-1], 240)


class DiscordVisionJobStore:
    """Bounded, process-memory prompt history for the Discord Vision dashboard.

    The shared in-memory SQLite database exists only while this store object is
    alive. It never creates a database, WAL, thumbnail, image, or prompt file.
    It also never receives Discord URLs or IDs, model evidence, queue tickets,
    process IDs, tokens, or filesystem paths.
    """

    def __init__(self, root: Path, terminal_limit: int = 200, max_active: int = 16):
        del root  # API compatibility; privacy mode deliberately ignores disk roots.
        self.path = None
        self._lock = threading.RLock()
        self._db = sqlite3.connect(
            ":memory:",
            timeout=5.0,
            check_same_thread=False,
        )
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA busy_timeout=5000")
        self.terminal_limit = max(10, min(int(terminal_limit), 1000))
        self.max_active = max(1, min(int(max_active), 64))
        self._initialize()

    def connect(self):
        return self._db

    def close(self) -> None:
        with self._lock:
            database = getattr(self, "_db", None)
            if database is not None:
                database.close()
                self._db = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

    @contextmanager
    def session(self):
        with self._lock:
            db = self.connect()
            with db:
                yield db

    def _initialize(self) -> None:
        with self.session() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS discord_vision_jobs (
                    id TEXT PRIMARY KEY,
                    created REAL NOT NULL,
                    updated REAL NOT NULL,
                    started REAL,
                    finished REAL,
                    image_hash TEXT NOT NULL,
                    filename TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL DEFAULT '',
                    queue_ahead INTEGER NOT NULL DEFAULT 0,
                    prompt TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    requested_model TEXT NOT NULL DEFAULT '',
                    prompt_words INTEGER NOT NULL DEFAULT 0,
                    public_error TEXT NOT NULL DEFAULT '',
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    reproducibility_json TEXT NOT NULL DEFAULT '{}',
                    prompt_variants_json TEXT NOT NULL DEFAULT '[]'
                )
                """
            )
            columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(discord_vision_jobs)").fetchall()
            }
            migrations = {
                "requested_model": "TEXT NOT NULL DEFAULT ''",
                "cancel_requested": "INTEGER NOT NULL DEFAULT 0",
                "reproducibility_json": "TEXT NOT NULL DEFAULT '{}'",
                "prompt_variants_json": "TEXT NOT NULL DEFAULT '[]'",
            }
            for name, declaration in migrations.items():
                if name not in columns:
                    db.execute(
                        f"ALTER TABLE discord_vision_jobs ADD COLUMN {name} {declaration}"
                    )
            db.execute(
                "CREATE INDEX IF NOT EXISTS discord_vision_jobs_updated "
                "ON discord_vision_jobs(updated DESC)"
            )
            self._prune(db)

    def _prune(self, db) -> None:
        rows = db.execute(
            """
            SELECT id FROM discord_vision_jobs
            WHERE status IN ('completed','rejected','error','cancelled')
            ORDER BY updated DESC
            LIMIT -1 OFFSET ?
            """,
            (self.terminal_limit,),
        ).fetchall()
        if rows:
            db.executemany(
                "DELETE FROM discord_vision_jobs WHERE id=?",
                ((row["id"],) for row in rows),
            )

    def create(
        self,
        image_hash: str,
        filename: str = "",
        *,
        model: str = "",
        created: float | None = None,
        job_id: str | None = None,
    ) -> str:
        digest = str(image_hash or "").strip().lower()
        if not HASH_RE.fullmatch(digest):
            raise ValueError("Discord Vision jobs require a full SHA-256 image hash.")
        requested_job_id = str(job_id or uuid.uuid4().hex).strip().lower()
        if not JOB_ID_RE.fullmatch(requested_job_id):
            raise ValueError("Discord Vision job IDs must be 32 lowercase hexadecimal characters.")
        now = float(created if created is not None else time.time())
        with self.session() as db:
            active = db.execute(
                "SELECT COUNT(*) FROM discord_vision_jobs WHERE status IN ('queued','running')"
            ).fetchone()[0]
            if active >= self.max_active:
                raise RuntimeError("The local Discord Vision dashboard is at its active-job limit.")
            db.execute(
                """
                INSERT INTO discord_vision_jobs(
                    id,created,updated,image_hash,filename,status,stage,model,requested_model
                ) VALUES(?,?,?,?,?,'queued','Waiting for the shared GPU queue',?,?)
                """,
                (
                    requested_job_id,
                    now,
                    now,
                    digest,
                    _safe_filename(filename),
                    _clean_text(model, 160),
                    _clean_text(model, 160),
                ),
            )
            self._prune(db)
        return requested_job_id

    def update(
        self,
        job_id: str,
        *,
        status: str | None = None,
        stage: str | None = None,
        queue_ahead: int | None = None,
        public_error: str | None = None,
    ) -> None:
        fields: dict[str, object] = {"updated": time.time()}
        if status is not None:
            normalized = str(status).strip().lower()
            if normalized not in VALID_STATUSES:
                raise ValueError("Unknown Discord Vision job status.")
            fields["status"] = normalized
            if normalized == "running":
                fields["started"] = fields["updated"]
            if normalized in TERMINAL_STATUSES:
                fields["finished"] = fields["updated"]
        if stage is not None:
            fields["stage"] = _clean_text(stage, 240)
        if queue_ahead is not None:
            fields["queue_ahead"] = max(0, min(int(queue_ahead), 10000))
        if public_error is not None:
            fields["public_error"] = _clean_text(public_error, 300)

        assignments = ",".join(f"{name}=?" for name in fields)
        values = [*fields.values(), str(job_id)]
        with self.session() as db:
            if fields.get("status") == "running":
                assignments = assignments.replace(
                    "started=?", "started=COALESCE(started, ?)"
                )
            db.execute(
                f"UPDATE discord_vision_jobs SET {assignments} WHERE id=?",
                values,
            )
            self._prune(db)

    def complete(
        self,
        job_id: str,
        *,
        prompt: str,
        model: str,
        prompt_words: int,
        prompt_variants: list[str] | None = None,
    ) -> None:
        original_prompt = str(prompt or "").strip()
        cleaned_prompt = recover_prompt_value(original_prompt)
        if not cleaned_prompt or len(cleaned_prompt) > 8000:
            raise ValueError("Completed Discord Vision prompts must be bounded non-empty text.")
        cleaned_variants=[]
        for item in prompt_variants or []:
            cleaned=recover_prompt_value(str(item or "").strip())
            if not cleaned or len(cleaned)>8000:
                raise ValueError("Completed Discord Vision prompt variations must be bounded non-empty text.")
            cleaned_variants.append(cleaned)
        if cleaned_variants:
            if len(cleaned_variants)!=3 or len(set(cleaned_variants))!=3:
                raise ValueError("Completed Discord Vision jobs require exactly three distinct prompt variations.")
            cleaned_prompt=cleaned_variants[0]
        else:
            cleaned_variants=[cleaned_prompt]
        if cleaned_prompt != original_prompt:
            prompt_words = len(re.findall(r"\b[\w'’-]+\b", cleaned_prompt, re.UNICODE))
        serialized_variants=json.dumps(cleaned_variants,ensure_ascii=True,separators=(",",":"))
        if len(serialized_variants.encode("utf-8"))>24_576:
            raise ValueError("Completed Discord Vision prompt variations exceed the local history limit.")
        now = time.time()
        with self.session() as db:
            db.execute(
                """
                UPDATE discord_vision_jobs
                SET status='completed', stage='Prompt ready', updated=?,
                    started=COALESCE(started, created), finished=?, queue_ahead=0,
                    prompt=?, prompt_variants_json=?, model=?, prompt_words=?, public_error=''
                WHERE id=? AND status IN ('queued','running') AND cancel_requested=0
                """,
                (
                    now,
                    now,
                    cleaned_prompt,
                    serialized_variants,
                    _clean_text(model, 160),
                    max(0, min(int(prompt_words), 10000)),
                    str(job_id),
                ),
            )
            self._prune(db)

    def set_reproducibility(self, job_id: str, payload: dict) -> None:
        serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > 16_384:
            raise ValueError("Reproducibility records must be 16 KiB or smaller.")
        with self.session() as db:
            db.execute(
                "UPDATE discord_vision_jobs SET reproducibility_json=?,updated=? WHERE id=?",
                (serialized, time.time(), str(job_id)),
            )

    def request_cancel(self, job_id: str) -> bool:
        now = time.time()
        with self.session() as db:
            cursor = db.execute(
                """
                UPDATE discord_vision_jobs
                SET cancel_requested=1, updated=?, stage='Cancellation requested'
                WHERE id=? AND status IN ('queued','running')
                """,
                (now, str(job_id)),
            )
            return cursor.rowcount > 0

    def is_cancel_requested(self, job_id: str) -> bool:
        with self.session() as db:
            row = db.execute(
                "SELECT cancel_requested FROM discord_vision_jobs WHERE id=?",
                (str(job_id),),
            ).fetchone()
        return bool(row and row["cancel_requested"])

    def cancel(self, job_id: str, stage: str = "Cancelled by the user") -> bool:
        now = time.time()
        with self.session() as db:
            cursor = db.execute(
                """
                UPDATE discord_vision_jobs
                SET status='cancelled', cancel_requested=1, stage=?, updated=?,
                    finished=?, queue_ahead=0, public_error=''
                WHERE id=? AND status IN ('queued','running')
                """,
                (_clean_text(stage, 240), now, now, str(job_id)),
            )
            self._prune(db)
            return cursor.rowcount > 0

    def clear_terminal(self) -> int:
        with self.session() as db:
            cursor = db.execute(
                "DELETE FROM discord_vision_jobs WHERE status IN ('completed','rejected','error','cancelled')"
            )
            return max(0, int(cursor.rowcount))

    @staticmethod
    def _public(row: sqlite3.Row, *, include_prompt: bool, now: float) -> dict:
        started = row["started"] or row["created"]
        finished = row["finished"] or (now if row["status"] in ACTIVE_STATUSES else row["updated"])
        stored_prompt = row["prompt"] or ""
        prompt = recover_prompt_value(stored_prompt)
        try:
            raw_variants=json.loads(row["prompt_variants_json"] or "[]")
        except (TypeError,json.JSONDecodeError):
            raw_variants=[]
        prompt_variants=[]
        if isinstance(raw_variants,list):
            for value in raw_variants[:3]:
                if isinstance(value,str):
                    cleaned=recover_prompt_value(value.strip())
                    if cleaned and len(cleaned)<=8000:
                        prompt_variants.append(cleaned)
        if not prompt_variants and prompt:
            prompt_variants=[prompt]
        prompt_words = row["prompt_words"]
        if prompt != stored_prompt:
            prompt_words = len(re.findall(r"\b[\w'’-]+\b", prompt, re.UNICODE))
        item = {
            "id": row["id"],
            "created": row["created"],
            "updated": row["updated"],
            "started": row["started"],
            "finished": row["finished"],
            "duration_seconds": max(0.0, round(float(finished) - float(started), 1)),
            "image_hash": row["image_hash"],
            "filename": row["filename"],
            "status": row["status"],
            "stage": row["stage"],
            "queue_ahead": row["queue_ahead"],
            "model": row["model"],
            "requested_model": row["requested_model"],
            "prompt_words": prompt_words,
            "prompt_preview": _clean_text(prompt, 280),
            "prompt_count": len(prompt_variants),
            "has_prompt": bool(prompt),
            "public_error": row["public_error"],
            "cancel_requested": bool(row["cancel_requested"]),
            "has_reproducibility": bool(row["reproducibility_json"] not in ("", "{}")),
        }
        if include_prompt:
            item["prompt"] = prompt
            item["prompt_variants"] = prompt_variants
            try:
                reproducibility = json.loads(row["reproducibility_json"] or "{}")
            except (TypeError, json.JSONDecodeError):
                reproducibility = {}
            item["reproducibility"] = reproducibility if isinstance(reproducibility, dict) else {}
        return item

    def list(self, limit: int = 100) -> list[dict]:
        maximum = max(1, min(int(limit), 200))
        with self.session() as db:
            rows = db.execute(
                """
                SELECT * FROM discord_vision_jobs
                ORDER BY
                    CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END,
                    CASE WHEN status IN ('queued','running') THEN created END ASC,
                    updated DESC
                LIMIT ?
                """,
                (maximum,),
            ).fetchall()
        now = time.time()
        return [self._public(row, include_prompt=False, now=now) for row in rows]

    def get(self, job_id: str) -> dict | None:
        with self.session() as db:
            row = db.execute(
                "SELECT * FROM discord_vision_jobs WHERE id=?", (str(job_id),)
            ).fetchone()
        return self._public(row, include_prompt=True, now=time.time()) if row else None

    def summary(self) -> dict:
        cutoff = time.time() - 86400
        with self.session() as db:
            counts = {
                row["status"]: row["count"]
                for row in db.execute(
                    "SELECT status,COUNT(*) AS count FROM discord_vision_jobs GROUP BY status"
                ).fetchall()
            }
            completed_24h = db.execute(
                "SELECT COUNT(*) FROM discord_vision_jobs "
                "WHERE status='completed' AND finished>=?",
                (cutoff,),
            ).fetchone()[0]
        return {
            "queued": counts.get("queued", 0),
            "running": counts.get("running", 0),
            "completed_24h": completed_24h,
            "rejected": counts.get("rejected", 0),
            "errors": counts.get("error", 0),
            "cancelled": counts.get("cancelled", 0),
        }
