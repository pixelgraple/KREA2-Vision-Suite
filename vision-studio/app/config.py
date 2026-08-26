from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv
import yaml

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
with (ROOT / "config.example.yaml").open("r", encoding="utf-8") as handle:
    DEFAULTS = yaml.safe_load(handle)

def val(name: str, default): return os.getenv(name, str(default))
def flag(name: str, default: bool): return val(name, default).lower() in {"1", "true", "yes", "on"}

@dataclass(frozen=True)
class Settings:
    backend: str = val("QWEN_BACKEND", DEFAULTS["model"]["backend"])
    model: str = val("QWEN_MODEL", DEFAULTS["model"]["model"])
    api_base: str = val("QWEN_API_BASE", DEFAULTS["model"]["api_base"])
    api_key: str = os.getenv("QWEN_API_KEY", "")
    context_length: int = int(val("QWEN_CONTEXT_LENGTH", DEFAULTS["model"]["context_length"]))
    max_output_tokens: int = int(val("QWEN_MAX_OUTPUT_TOKENS", DEFAULTS["model"]["max_output_tokens"]))
    keep_alive: str = val("QWEN_KEEP_ALIVE", DEFAULTS["model"]["keep_alive"])
    llama_cpp_server_exe: str = val("LLAMA_CPP_SERVER_EXE", DEFAULTS["llama_cpp"]["server_exe"])
    llama_cpp_model_root: str = val("LLAMA_CPP_MODEL_ROOT", DEFAULTS["llama_cpp"]["model_root"])
    llama_cpp_artifact_manifest: str = val("LLAMA_CPP_ARTIFACT_MANIFEST", DEFAULTS["llama_cpp"]["artifact_manifest"])
    llama_cpp_port: int = int(val("LLAMA_CPP_PORT", DEFAULTS["llama_cpp"]["port"]))
    llama_cpp_startup_timeout_seconds: float = float(val("LLAMA_CPP_STARTUP_TIMEOUT_SECONDS", DEFAULTS["llama_cpp"]["startup_timeout_seconds"]))
    llama_cpp_vram_headroom_mb: int = int(val("LLAMA_CPP_VRAM_HEADROOM_MB", DEFAULTS["llama_cpp"]["vram_headroom_mb"]))
    llama_cpp_model_allocation_target_mb: int = int(val("LLAMA_CPP_MODEL_ALLOCATION_TARGET_MB", DEFAULTS["llama_cpp"]["model_allocation_target_mb"]))
    llama_cpp_telemetry_path: str = val("LLAMA_CPP_TELEMETRY_PATH", DEFAULTS["llama_cpp"]["telemetry_path"])
    llama_cpp_context_cap: int = int(val("LLAMA_CPP_CONTEXT_CAP", DEFAULTS["llama_cpp"]["context_cap"]))
    vast_serverless_enabled: bool = flag("VAST_SERVERLESS_ENABLED", DEFAULTS["vast_serverless"]["enabled"])
    vast_serverless_endpoint: str = val("VAST_SERVERLESS_ENDPOINT", DEFAULTS["vast_serverless"]["endpoint"])
    vast_serverless_api_key: str = os.getenv("VAST_SERVERLESS_API_KEY", "")
    vast_serverless_python_exe: str = val("VAST_SERVERLESS_PYTHON_EXE", DEFAULTS["vast_serverless"]["python_exe"])
    vast_serverless_request_timeout_seconds: float = float(val("VAST_SERVERLESS_REQUEST_TIMEOUT_SECONDS", DEFAULTS["vast_serverless"]["request_timeout_seconds"]))
    vast_serverless_model_id: str = val("VAST_SERVERLESS_MODEL_ID", DEFAULTS["vast_serverless"]["model_id"])
    temp_analysis: float = float(val("QWEN_TEMPERATURE_ANALYSIS", DEFAULTS["model"]["temperatures"]["analysis"]))
    temp_critic: float = float(val("QWEN_TEMPERATURE_CRITIC", DEFAULTS["model"]["temperatures"]["critic"]))
    temp_merger: float = float(val("QWEN_TEMPERATURE_MERGER", DEFAULTS["model"]["temperatures"]["merger"]))
    temp_composer: float = float(val("QWEN_TEMPERATURE_COMPOSER", DEFAULTS["model"]["temperatures"]["composer"]))
    host: str = val("STUDIO_HOST", DEFAULTS["app"]["host"])
    port: int = int(val("STUDIO_PORT", DEFAULTS["app"]["port"]))
    max_upload_mb: int = int(val("STUDIO_MAX_UPLOAD_MB", DEFAULTS["app"]["max_upload_mb"]))
    max_image_pixels: int = int(val("STUDIO_MAX_IMAGE_PIXELS", DEFAULTS["app"]["max_image_pixels"]))
    max_image_side: int = int(val("STUDIO_MAX_IMAGE_SIDE", DEFAULTS["app"]["max_image_side"]))
    privacy_mode: bool = flag("STUDIO_PRIVACY_MODE", DEFAULTS["app"]["privacy_mode"])
    save_source_images: bool = flag("STUDIO_SAVE_SOURCE_IMAGES", DEFAULTS["app"]["save_source_images"])
    save_thumbnails: bool = flag("STUDIO_SAVE_THUMBNAILS", DEFAULTS["app"]["save_thumbnails"])
    queue_enabled: bool = flag("STUDIO_USE_SHARED_GENERATION_QUEUE", DEFAULTS["queue"]["enabled"])
    queue_dir: str = val("STUDIO_SHARED_QUEUE_DIR", DEFAULTS["queue"]["directory"])
    queue_poll_seconds: float = float(val("STUDIO_SHARED_QUEUE_POLL_SECONDS", DEFAULTS["queue"]["poll_seconds"]))
    queue_stale_seconds: float = float(val("STUDIO_SHARED_QUEUE_STALE_SECONDS", DEFAULTS["queue"]["stale_ticket_seconds"]))
    gpu_availability_timeout_seconds: float = float(val("KREA2_GPU_AVAILABILITY_TIMEOUT_SECONDS", DEFAULTS["queue"]["gpu_availability_timeout_seconds"]))
    forge_unload_urls: str = val("STUDIO_FORGE_UNLOAD_URLS", DEFAULTS["queue"]["forge_unload_urls"])
    forge_unload_timeout_seconds: float = float(val("STUDIO_FORGE_UNLOAD_TIMEOUT_SECONDS", DEFAULTS["queue"]["forge_unload_timeout_seconds"]))
    forge_handoff_token_file: str = val("STUDIO_FORGE_HANDOFF_TOKEN_FILE", DEFAULTS["queue"]["forge_handoff_token_file"])
    discord_vision_token: str = os.getenv("KREA2_DISCORD_VISION_TOKEN", "")
    wd14_model: str = val("WD14_MODEL", DEFAULTS["wd14"]["model"])
    wd14_device: str = val("WD14_DEVICE", DEFAULTS["wd14"]["device"])

    @property
    def llama_cpp_api_base(self) -> str:
        """llama.cpp is deliberately loopback-only; only its port is configurable."""
        return f"http://127.0.0.1:{self.llama_cpp_port}"

settings = Settings()
