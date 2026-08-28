from __future__ import annotations
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from fastapi import FastAPI
from .api.analyze import discord_jobs, router

logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _configure_private_runtime_log() -> None:
    """Keep bounded operational diagnostics without persisting images/prompts."""

    log_dir = Path(__file__).resolve().parents[1] / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = (log_dir / "vision_backend.log").resolve()
    root = logging.getLogger()
    for handler in root.handlers:
        if isinstance(handler, RotatingFileHandler):
            try:
                if Path(handler.baseFilename).resolve() == log_path:
                    return
            except (OSError, ValueError):
                continue
    handler = RotatingFileHandler(
        log_path,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(handler)


_configure_private_runtime_log()
app=FastAPI(title="KREA2 Vision Prompt Studio",version="1.0.0")
app.include_router(router)


@app.on_event("startup")
def recover_abandoned_discord_jobs() -> None:
    """Reconcile active history only when the real server starts."""

    discord_jobs.recover_active_after_restart()


@app.get("/health")
def health(): return {"ok":True}
@app.get("/",include_in_schema=False)
def backend_root():
    return {
        "ok": True,
        "service": "KREA2 Vision backend",
        "interface": "BetterDiscord plugin",
    }
