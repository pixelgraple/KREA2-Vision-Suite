from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

import requests

from ..config import ROOT, Settings


_VERIFIED_ARTIFACT_CACHE_NAME = ".krea2-verified-artifacts-v1.json"
_VERIFIED_ARTIFACT_CACHE_LOCK = threading.RLock()


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """An immutable model selection with private, server-side launch paths."""

    public_id: str
    label: str
    backend: str
    provider_model: str
    local_gpu: bool
    context_cap: int
    max_output_cap: int
    estimated_vram_mb: int
    server_exe: Path | None = field(default=None, repr=False)
    model_path: Path | None = field(default=None, repr=False)
    mmproj_path: Path | None = field(default=None, repr=False)
    artifact_manifest: Path | None = field(default=None, repr=False)
    quantization: str = ""
    model_sha256: str = field(default="", repr=False)
    model_bytes: int = field(default=0, repr=False)
    mmproj_sha256: str = field(default="", repr=False)
    mmproj_bytes: int = field(default=0, repr=False)
    artifact_revision: str = field(default="", repr=False)
    runtime_bundle_id: str = field(default="", repr=False)
    runtime_release: str = field(default="", repr=False)

    def public_status(self) -> dict[str, str | bool | int]:
        """Serialize only fields that are safe to send to a browser."""
        return {
            "public_id": self.public_id,
            "label": self.label,
            "backend": self.backend,
            "local_gpu": self.local_gpu,
            "context_cap": self.context_cap,
            "max_output_cap": self.max_output_cap,
            "estimated_vram_mb": self.estimated_vram_mb,
        }


@dataclass(frozen=True, slots=True)
class _ModelDefinition:
    public_id: str
    label: str
    backend: str
    provider_model: str
    context_cap: int
    max_output_cap: int
    estimated_vram_mb: int
    manifest_id: str = ""
    model_relative_path: str = ""
    mmproj_relative_paths: tuple[str, ...] = ()


OLLAMA_DEFINITIONS = (
    _ModelDefinition(
        "ollama::qwen3-vl:30b",
        "Quality — Qwen3-VL 30B",
        "ollama",
        "qwen3-vl:30b",
        32768,
        8192,
        24576,
    ),
    _ModelDefinition(
        "ollama::qwen3-vl:8b",
        "Fast — Qwen3-VL 8B",
        "ollama",
        "qwen3-vl:8b",
        32768,
        8192,
        8192,
    ),
)

# Kept for the existing Gradio UI and tests. Its values intentionally remain
# raw Ollama tags until that UI is migrated to provider-aware ModelSpec values.
MODELS = tuple((item.label, item.provider_model) for item in OLLAMA_DEFINITIONS)

LLAMA_CPP_DEFINITIONS = (
    _ModelDefinition(
        "llamacpp::heretic-2b-f16",
        "Heretic — Qwen3-VL 2B F16",
        "llama_cpp",
        "qwen3-vl-heretic-2b-f16",
        8192,
        2048,
        6144,
        "qwen3-vl-heretic-2b-f16",
        "2B/Qwen-3-VL-2B-Instruct-heretic.f16.gguf",
        (
            "2B/Qwen-3-VL-2B-Instruct-heretic.mmproj-Q8_0.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::heretic-4b-q8_0",
        "Heretic — Qwen3-VL 4B Q8_0",
        "llama_cpp",
        "qwen3-vl-heretic-4b-q8-0",
        8192,
        2048,
        7680,
        "qwen3-vl-heretic-4b-q8-0",
        "4B/Qwen3-VL-4B-Instruct-heretic.Q8_0.gguf",
        (
            "4B/Qwen3-VL-4B-Instruct-heretic.mmproj-Q8_0.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::heretic-8b-q8_0",
        "Heretic — Qwen3-VL 8B Q8_0",
        "llama_cpp",
        "qwen3-vl-heretic-8b-q8-0",
        6144,
        2048,
        13312,
        "qwen3-vl-heretic-8b-q8-0",
        "8B/Qwen-3-VL-8B-Instruct-heretic.Q8_0.gguf",
        (
            "8B/Qwen-3-VL-8B-Instruct-heretic.mmproj-Q8_0.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::glm4-9b-abliterated-q5_k_m",
        "Abliterated — GLM-4.6V Flash 9B Q5_K_M",
        "llama_cpp",
        "glm4-9b-abliterated-q5-k-m",
        8192,
        2048,
        12288,
        "glm4-9b-abliterated-q5-k-m",
        "9B-GLM-Abliterated/Huihui-GLM-4.6V-Flash-abliterated-Q5_K_M.gguf",
        (
            "9B-GLM-Abliterated/Huihui-GLM-4.6V-Flash-abliterated.mmproj-Q8_0.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::gemma4-12b-opus-uncensored-q8_0",
        "Uncensored — Gemma 4 12B Opus 4.7 CoT Q8_0",
        "llama_cpp",
        "gemma4-12b-opus-uncensored-q8-0",
        8192,
        2048,
        20992,
        "gemma4-12b-opus-uncensored-q8-0",
        "12B-Opus/gemma-4-12B-it-uncensored-opus4.7-cot-Q8_0.gguf",
        (
            "12B-Opus/mmproj-gemma-4-12B-it-Q8_0.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::gemma4-12b-heretic-q8_0",
        "Heretic — Gemma 4 12B Q8_0",
        "llama_cpp",
        "gemma4-12b-heretic-q8-0",
        8192,
        2048,
        20992,
        "gemma4-12b-heretic-q8-0",
        "12B-Heretic/gemma-4-12B-it-uncensored-heretic-Q8_0.gguf",
        (
            "12B-Heretic/gemma-4-12B-it-uncensored-heretic-mmproj-BF16.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::gemma4-26b-a4b-heretic-q3_k_l",
        "Heretic — Gemma 4 26B-A4B Q3_K_L",
        "llama_cpp",
        "gemma4-26b-a4b-heretic-q3-k-l",
        8192,
        2048,
        24576,
        "gemma4-26b-a4b-heretic-q3-k-l",
        "26B-A4B-Heretic/gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf",
        (
            "26B-A4B-Heretic/gemma-4-26B-A4B-it-mmproj-BF16.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k",
        "Abliterated — Qwen3-VL 30B-A3B Q2_K",
        "llama_cpp",
        "qwen3-vl-30b-a3b-abliterated-q2-k",
        8192,
        2048,
        18432,
        "qwen3-vl-30b-a3b-abliterated-q2-k",
        "30B-A3B-Abliterated/Qwen3-VL-30B-A3B-Instruct-abliterated.Q2_K.gguf",
        (
            "30B-A3B-Abliterated/Qwen3-VL-30B-A3B-Instruct-abliterated.mmproj-Q8_0.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::gemma4-31b-heretic-q4_k_m",
        "Heretic — Gemma 4 31B Q4_K_M",
        "llama_cpp",
        "gemma4-31b-heretic-q4-k-m",
        8192,
        2048,
        24576,
        "gemma4-31b-heretic-q4-k-m",
        "31B/gemma-4-31B-it-uncensored-heretic-Q4_K_M.gguf",
        (
            "31B/gemma-4-31B-it-mmproj-BF16.gguf",
        ),
    ),
    _ModelDefinition(
        "llamacpp::qwen3-vl-32b-heretic-q4_k_m",
        "Heretic — Qwen3-VL 32B Q4_K_M",
        "llama_cpp",
        "qwen3-vl-32b-heretic-q4-k-m",
        8192,
        2048,
        26624,
        "qwen3-vl-32b-heretic-q4-k-m",
        "32B/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-Q4_K_M.gguf",
        (
            "32B/Qwen3-VL-32B-Instruct-mmproj-BF16.gguf",
        ),
    ),
)

VAST_SERVERLESS_DEFINITION = _ModelDefinition(
    "vast::gemma4-26b-a4b-heretic-q3_k_l",
    "Dedicated RTX 3090 — Gemma 4 26B-A4B Heretic Q3_K_L (24 GB GPU)",
    "vast_serverless",
    "gemma4-26b-a4b-heretic-q3-k-l",
    8192,
    2048,
    18432,
)

_KNOWN_PUBLIC_IDS = {
    item.public_id
    for item in (*OLLAMA_DEFINITIONS, *LLAMA_CPP_DEFINITIONS, VAST_SERVERLESS_DEFINITION)
}
_LEGACY_OLLAMA_IDS = {
    item.provider_model: item.public_id for item in OLLAMA_DEFINITIONS
}
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}\Z")


class UnknownModelError(ValueError):
    pass


class ModelUnavailableError(ValueError):
    pass


def _installed_ollama_names(api_base: str) -> set[str]:
    try:
        response = requests.get(f"{api_base.rstrip('/')}/api/tags", timeout=5)
        response.raise_for_status()
        payload = response.json()
        models = payload.get("models", []) if isinstance(payload, dict) else []
        return {
            str(item.get("name", ""))
            for item in models
            if isinstance(item, dict) and item.get("name")
        }
    except (requests.RequestException, TypeError, ValueError):
        return set()


def installed_qwen3_vl(api_base: str) -> list[tuple[str, str]]:
    """Return only supported Studio models that Ollama confirms are installed."""
    installed = _installed_ollama_names(api_base)
    return [(label, tag) for label, tag in MODELS if tag in installed]


def available_ollama_specs(api_base: str) -> list[ModelSpec]:
    installed = _installed_ollama_names(api_base)
    return [
        ModelSpec(
            public_id=item.public_id,
            label=item.label,
            backend=item.backend,
            provider_model=item.provider_model,
            local_gpu=True,
            context_cap=item.context_cap,
            max_output_cap=item.max_output_cap,
            estimated_vram_mb=item.estimated_vram_mb,
        )
        for item in OLLAMA_DEFINITIONS
        if item.provider_model in installed
    ]


def _configured_path(raw: str, *, base: Path) -> Path | None:
    value = raw.strip()
    if not value:
        return None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        return candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        return None


def _checked_in_manifest(raw: str) -> Path | None:
    manifest = _configured_path(raw, base=ROOT)
    if manifest is None or not manifest.is_file():
        return None
    try:
        manifest.relative_to(ROOT.resolve(strict=True))
    except (OSError, RuntimeError, ValueError):
        return None
    try:
        if manifest.stat().st_size > 1_000_000:
            return None
    except OSError:
        return None
    return manifest


def _manifest_models(manifest: Path) -> dict[str, dict[str, Any]] | None:
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("version") != 1:
        return None
    models = payload.get("models")
    if not isinstance(models, list):
        return None
    indexed: dict[str, dict[str, Any]] = {}
    for entry in models:
        if not isinstance(entry, dict):
            return None
        public_id = entry.get("public_id")
        if not isinstance(public_id, str) or not public_id or public_id in indexed:
            return None
        indexed[public_id] = entry
    return indexed


def _artifact_metadata(
    artifact: object, expected_relative_path: str
) -> tuple[str, int, str] | None:
    if not isinstance(artifact, dict):
        return None
    relative_path = artifact.get("relative_path")
    expected_bytes = artifact.get("bytes")
    expected_sha256 = artifact.get("sha256")
    if relative_path != expected_relative_path:
        return None
    if (
        isinstance(expected_bytes, bool)
        or not isinstance(expected_bytes, int)
        or expected_bytes <= 0
    ):
        return None
    if not isinstance(expected_sha256, str) or not _SHA256_RE.fullmatch(expected_sha256):
        return None
    return relative_path, expected_bytes, expected_sha256.lower()


def _artifact_candidates(entry: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """Read the settled alternatives-array schema and its original single item."""
    raw = entry.get(key)
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list) and all(isinstance(item, dict) for item in raw):
        return raw
    return []


def _artifact_options(
    entry: dict[str, Any], key: str, expected_relative_paths: tuple[str, ...]
) -> list[tuple[str, int, str]]:
    candidates = _artifact_candidates(entry, key)
    options: list[tuple[str, int, str]] = []
    for expected_relative_path in expected_relative_paths:
        for candidate in candidates:
            metadata = _artifact_metadata(candidate, expected_relative_path)
            if metadata is not None:
                options.append(metadata)
                break
    return options


def _artifact_path(model_root: Path, relative_path: str) -> Path | None:
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        return None
    try:
        candidate = model_root.joinpath(*relative.parts).resolve(strict=True)
        candidate.relative_to(model_root)
    except (OSError, RuntimeError, ValueError):
        return None
    return candidate if candidate.is_file() else None


@lru_cache(maxsize=64)
def _sha256_for_fingerprint(
    path: str, size: int, mtime_ns: int, ctime_ns: int, inode: int
) -> str:
    del size, mtime_ns, ctime_ns, inode
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_fingerprint(path: Path, stat: Any, expected_sha256: str) -> dict[str, str | int]:
    return {
        "sha256": expected_sha256.lower(),
        "bytes": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
        "ctime_ns": int(stat.st_ctime_ns),
        "inode": int(stat.st_ino),
    }


def _verification_cache_path(model_root: Path) -> Path:
    return model_root / _VERIFIED_ARTIFACT_CACHE_NAME


def _read_verification_cache(model_root: Path) -> dict[str, Any]:
    cache_path = _verification_cache_path(model_root)
    try:
        if cache_path.stat().st_size > 1_000_000:
            return {"version": 1, "artifacts": {}}
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"version": 1, "artifacts": {}}
    if not isinstance(payload, dict):
        return {"version": 1, "artifacts": {}}
    artifacts = payload.get("artifacts")
    if payload.get("version") != 1 or not isinstance(artifacts, dict):
        return {"version": 1, "artifacts": {}}
    return {"version": 1, "artifacts": artifacts}


def _artifact_cache_key(model_root: Path, path: Path) -> str | None:
    try:
        return path.resolve(strict=True).relative_to(model_root.resolve(strict=True)).as_posix()
    except (OSError, RuntimeError, ValueError):
        return None


def remember_verified_artifact(model_root: Path, path: Path, expected_sha256: str) -> None:
    """Persist a successful full hash so later process starts can verify in milliseconds."""
    if not _SHA256_RE.fullmatch(expected_sha256):
        return
    key = _artifact_cache_key(model_root, path)
    if key is None:
        return
    try:
        stat = path.stat()
    except OSError:
        return
    with _VERIFIED_ARTIFACT_CACHE_LOCK:
        payload = _read_verification_cache(model_root)
        artifacts = dict(payload["artifacts"])
        artifacts[key] = _artifact_fingerprint(path, stat, expected_sha256)
        payload = {"version": 1, "artifacts": artifacts}
        cache_path = _verification_cache_path(model_root)
        temporary = cache_path.with_name(
            f".{cache_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            temporary.write_text(
                json.dumps(payload, sort_keys=True, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, cache_path)
        except OSError:
            temporary.unlink(missing_ok=True)


def _matches_verification_cache(
    model_root: Path, path: Path, stat: Any, expected_sha256: str
) -> bool:
    key = _artifact_cache_key(model_root, path)
    if key is None:
        return False
    with _VERIFIED_ARTIFACT_CACHE_LOCK:
        record = _read_verification_cache(model_root)["artifacts"].get(key)
    if not isinstance(record, dict):
        return False
    expected = _artifact_fingerprint(path, stat, expected_sha256)
    if record.keys() != expected.keys():
        return False
    if not isinstance(record.get("sha256"), str) or not hmac.compare_digest(
        record["sha256"], expected["sha256"]
    ):
        return False
    return all(record.get(field) == expected[field] for field in ("bytes", "mtime_ns", "ctime_ns", "inode"))


def _verified_artifact(
    model_root: Path, metadata: tuple[str, int, str]
) -> Path | None:
    relative_path, expected_bytes, expected_sha256 = metadata
    path = _artifact_path(model_root, relative_path)
    if path is None:
        return None
    try:
        stat = path.stat()
        if stat.st_size != expected_bytes:
            return None
        if _matches_verification_cache(model_root, path, stat, expected_sha256):
            return path
        actual_sha256 = _sha256_for_fingerprint(
            str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino
        )
    except OSError:
        return None
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        return None
    remember_verified_artifact(model_root, path, expected_sha256)
    return path


def _first_verified_artifact(
    model_root: Path, options: list[tuple[str, int, str]]
) -> Path | None:
    for metadata in options:
        verified = _verified_artifact(model_root, metadata)
        if verified is not None:
            return verified
    return None


def _supported_server_binary(path: Path | None) -> bool:
    """Accept the native llama.cpp server name while retaining executable checks."""

    if path is None or not path.is_file():
        return False
    if os.name == "nt":
        return path.suffix.casefold() == ".exe"
    return os.access(path, os.X_OK)


def available_llama_cpp_specs(config: Settings) -> list[ModelSpec]:
    server_exe = _configured_path(config.llama_cpp_server_exe, base=ROOT)
    model_root = _configured_path(config.llama_cpp_model_root, base=ROOT)
    manifest = _checked_in_manifest(config.llama_cpp_artifact_manifest)
    if (
        not _supported_server_binary(server_exe)
        or model_root is None
        or not model_root.is_dir()
        or manifest is None
        or not 1 <= config.llama_cpp_port <= 65535
        or config.llama_cpp_context_cap <= 0
    ):
        return []
    entries = _manifest_models(manifest)
    if entries is None:
        return []
    try:
        manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return []
    runtime = manifest_payload.get("llama_cpp", {})
    runtime_bundle_id = str(manifest_payload.get("bundle_id") or "")[:160]
    runtime_release = str(runtime.get("release_tag") or runtime.get("target_commit") or "")[:160] if isinstance(runtime, dict) else ""

    available: list[ModelSpec] = []
    for definition in LLAMA_CPP_DEFINITIONS:
        entry = entries.get(definition.manifest_id)
        if entry is None:
            continue
        model_metadata = _artifact_metadata(entry.get("model"), definition.model_relative_path)
        mmproj_options = _artifact_options(
            entry, "mmproj", definition.mmproj_relative_paths
        )
        if model_metadata is None or not mmproj_options:
            continue
        model_path = _verified_artifact(model_root, model_metadata)
        selected_mmproj_metadata = next(
            (metadata for metadata in mmproj_options if _verified_artifact(model_root, metadata) is not None),
            None,
        )
        mmproj_path = _verified_artifact(model_root, selected_mmproj_metadata) if selected_mmproj_metadata else None
        if model_path is None or mmproj_path is None:
            continue
        context_cap = min(definition.context_cap, config.llama_cpp_context_cap)
        available.append(
            ModelSpec(
                public_id=definition.public_id,
                label=definition.label,
                backend=definition.backend,
                provider_model=definition.provider_model,
                local_gpu=True,
                context_cap=context_cap,
                max_output_cap=min(definition.max_output_cap, context_cap),
                estimated_vram_mb=definition.estimated_vram_mb,
                server_exe=server_exe,
                model_path=model_path,
                mmproj_path=mmproj_path,
                artifact_manifest=manifest,
                quantization=(
                    "F16" if "f16" in definition.public_id else
                    "Q5_K_M" if "q5_k_m" in definition.public_id else
                    "Q3_K_L" if "q3_k_l" in definition.public_id else
                    "Q2_K" if "q2_k" in definition.public_id else
                    "Q4_K_M" if "q4_k_m" in definition.public_id else
                    "Q8_0" if "q8_0" in definition.public_id else ""
                ),
                model_sha256=model_metadata[2],
                model_bytes=model_metadata[1],
                mmproj_sha256=selected_mmproj_metadata[2],
                mmproj_bytes=selected_mmproj_metadata[1],
                artifact_revision=str(entry.get("revision") or "")[:160],
                runtime_bundle_id=runtime_bundle_id,
                runtime_release=runtime_release,
            )
        )
    return available


def available_vast_serverless_specs(config: Settings) -> list[ModelSpec]:
    """Expose the one pinned remote model through the licensed HTTPS gateway."""
    definition = VAST_SERVERLESS_DEFINITION
    if (
        not config.vast_serverless_enabled
        or config.vast_serverless_model_id != definition.public_id
        or not re.fullmatch(r"https://[^/?#]+(?:/[^?#]*)?", config.remote_gateway_url)
        or not 30 <= config.vast_serverless_request_timeout_seconds <= 3600
    ):
        return []
    return [
        ModelSpec(
            public_id=definition.public_id,
            label=definition.label,
            backend=definition.backend,
            provider_model=definition.provider_model,
            local_gpu=False,
            context_cap=definition.context_cap,
            max_output_cap=definition.max_output_cap,
            estimated_vram_mb=definition.estimated_vram_mb,
            quantization="Q3_K_L",
        )
    ]


def available_model_specs(config: Settings) -> list[ModelSpec]:
    return [
        *available_ollama_specs(config.api_base),
        *available_llama_cpp_specs(config),
        *available_vast_serverless_specs(config),
    ]


def public_model_statuses(config: Settings) -> list[dict[str, str | bool | int]]:
    """Return available models without server paths, artifact names, or hashes."""
    return [spec.public_status() for spec in available_model_specs(config)]


def resolve_model(public_id: str, config: Settings) -> ModelSpec:
    canonical_id = _LEGACY_OLLAMA_IDS.get(public_id, public_id)
    if canonical_id not in _KNOWN_PUBLIC_IDS:
        raise UnknownModelError(f"Unknown model ID: {public_id}")
    available = {item.public_id: item for item in available_model_specs(config)}
    try:
        return available[canonical_id]
    except KeyError as exc:
        raise ModelUnavailableError(f"Model is not available locally: {public_id}") from exc


__all__ = [
    "LLAMA_CPP_DEFINITIONS",
    "VAST_SERVERLESS_DEFINITION",
    "MODELS",
    "ModelSpec",
    "ModelUnavailableError",
    "UnknownModelError",
    "available_llama_cpp_specs",
    "remember_verified_artifact",
    "available_model_specs",
    "available_ollama_specs",
    "available_vast_serverless_specs",
    "installed_qwen3_vl",
    "public_model_statuses",
    "resolve_model",
]
