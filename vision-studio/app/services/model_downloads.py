from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import threading
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import urlparse

import requests

from ..config import ROOT, Settings
from .model_catalog import remember_verified_artifact


MODEL_MANIFEST_IDS = {
    "llamacpp::heretic-2b-f16": "qwen3-vl-heretic-2b-f16",
    "llamacpp::heretic-4b-q8_0": "qwen3-vl-heretic-4b-q8-0",
    "llamacpp::heretic-8b-q8_0": "qwen3-vl-heretic-8b-q8-0",
    "llamacpp::glm4-9b-abliterated-q5_k_m": "glm4-9b-abliterated-q5-k-m",
    "llamacpp::gemma4-12b-opus-uncensored-q8_0": "gemma4-12b-opus-uncensored-q8-0",
    "llamacpp::gemma4-12b-heretic-q8_0": "gemma4-12b-heretic-q8-0",
    "llamacpp::gemma4-26b-a4b-heretic-q3_k_l": "gemma4-26b-a4b-heretic-q3-k-l",
    "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k": "qwen3-vl-30b-a3b-abliterated-q2-k",
    "llamacpp::gemma4-31b-heretic-q4_k_m": "gemma4-31b-heretic-q4-k-m",
    "llamacpp::qwen3-vl-32b-heretic-q4_k_m": "qwen3-vl-32b-heretic-q4-k-m",
}


class ModelDownloadError(RuntimeError):
    pass


class ModelDownloadBusy(ModelDownloadError):
    pass


def _configured_path(value: str, base: Path = ROOT) -> Path:
    expanded = Path(os.path.expandvars(value)).expanduser()
    return (expanded if expanded.is_absolute() else base / expanded).resolve()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ModelDownloadManager:
    """Install one pinned model body/projector pair at a time."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_get: Callable[..., Any] = requests.get,
    ) -> None:
        self.settings = settings
        self.http_get = http_get
        self._lock = threading.RLock()
        self._active_model = ""
        self._thread: threading.Thread | None = None
        self._statuses: dict[str, dict[str, Any]] = {}

    def status(self, public_id: str) -> dict[str, Any]:
        if public_id not in MODEL_MANIFEST_IDS:
            raise ModelDownloadError("Unknown pinned Vision model ID.")
        with self._lock:
            return dict(
                self._statuses.get(
                    public_id,
                    {
                        "model": public_id,
                        "state": "idle",
                        "stage": "Ready to install the model body and projector together",
                        "directory": "",
                        "file_name": "",
                        "bytes_downloaded": 0,
                        "bytes_total": 0,
                        "progress_percent": 0.0,
                        "error": "",
                    },
                )
            )

    def start(self, public_id: str) -> dict[str, Any]:
        if public_id not in MODEL_MANIFEST_IDS:
            raise ModelDownloadError("Unknown pinned Vision model ID.")
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                if self._active_model == public_id:
                    return self.status(public_id)
                raise ModelDownloadBusy(
                    "Another model pair is already downloading. Let it finish first."
                )
            self._active_model = public_id
            self._statuses[public_id] = {
                "model": public_id,
                "state": "queued",
                "stage": "Preparing pinned model body and projector",
                "directory": "",
                "file_name": "",
                "bytes_downloaded": 0,
                "bytes_total": 0,
                "progress_percent": 0.0,
                "error": "",
            }
            self._thread = threading.Thread(
                target=self._run,
                args=(public_id,),
                name="krea2-model-download",
                daemon=True,
            )
            self._thread.start()
            return self.status(public_id)

    def _update(self, public_id: str, **changes: Any) -> None:
        with self._lock:
            current = dict(self._statuses.get(public_id, {"model": public_id}))
            current.update(changes)
            total = max(0, int(current.get("bytes_total") or 0))
            downloaded = max(0, min(total, int(current.get("bytes_downloaded") or 0)))
            current["bytes_downloaded"] = downloaded
            current["progress_percent"] = round(downloaded * 100 / total, 2) if total else 0.0
            self._statuses[public_id] = current

    def _manifest_entry(self, public_id: str) -> tuple[dict[str, Any], Path]:
        manifest_path = _configured_path(self.settings.llama_cpp_artifact_manifest)
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ModelDownloadError("The pinned model manifest is unavailable.") from exc
        entries = payload.get("models")
        if not isinstance(entries, list):
            raise ModelDownloadError("The pinned model manifest is malformed.")
        manifest_id = MODEL_MANIFEST_IDS[public_id]
        entry = next(
            (item for item in entries if isinstance(item, dict) and item.get("public_id") == manifest_id),
            None,
        )
        if entry is None:
            raise ModelDownloadError("The selected model is missing from the pinned manifest.")
        model_root = _configured_path(self.settings.llama_cpp_model_root)
        return entry, model_root

    @staticmethod
    def _artifacts(entry: dict[str, Any]) -> list[dict[str, Any]]:
        model = entry.get("model")
        projectors = entry.get("mmproj")
        if not isinstance(model, dict) or not isinstance(projectors, list) or not projectors:
            raise ModelDownloadError("The selected model does not have a complete pinned pair.")
        projector = projectors[0]
        if not isinstance(projector, dict):
            raise ModelDownloadError("The selected model projector record is malformed.")
        return [model, projector]

    @staticmethod
    def _validated_artifact(artifact: dict[str, Any], expected_directory: str) -> dict[str, Any]:
        relative = PurePosixPath(str(artifact.get("relative_path") or ""))
        if relative.is_absolute() or ".." in relative.parts or len(relative.parts) != 2:
            raise ModelDownloadError("A pinned artifact path is unsafe.")
        if relative.parts[0] != expected_directory:
            raise ModelDownloadError("A pinned artifact is assigned to the wrong model folder.")
        url = str(artifact.get("url") or "")
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "huggingface.co":
            raise ModelDownloadError("A pinned artifact URL is not an approved Hugging Face URL.")
        expected_bytes = int(artifact.get("bytes") or 0)
        expected_sha = str(artifact.get("sha256") or "").lower()
        if expected_bytes <= 0 or len(expected_sha) != 64 or any(c not in "0123456789abcdef" for c in expected_sha):
            raise ModelDownloadError("A pinned artifact checksum record is malformed.")
        return {
            "relative": relative,
            "url": url,
            "bytes": expected_bytes,
            "sha256": expected_sha,
            "file_name": relative.name,
        }

    def _run(self, public_id: str) -> None:
        try:
            entry, model_root = self._manifest_entry(public_id)
            directory = str(entry.get("directory") or "")
            if not directory or any(part in {"", ".", ".."} for part in PurePosixPath(directory).parts):
                raise ModelDownloadError("The selected model folder is invalid.")
            artifacts = [
                self._validated_artifact(item, directory)
                for item in self._artifacts(entry)
            ]
            total = sum(int(item["bytes"]) for item in artifacts)
            model_root.mkdir(parents=True, exist_ok=True)
            destination = (model_root / directory).resolve()
            destination.relative_to(model_root)
            destination.mkdir(parents=True, exist_ok=True)
            self._update(
                public_id,
                state="downloading",
                stage="Installing model body and projector into one folder",
                directory=str(destination),
                bytes_total=total,
            )

            remaining = 0
            for item in artifacts:
                final = destination / str(item["file_name"])
                partial = final.with_name(final.name + ".partial")
                if final.exists():
                    if final.is_file() and final.stat().st_size == item["bytes"] and hmac.compare_digest(_sha256(final), item["sha256"]):
                        remember_verified_artifact(model_root, final, item["sha256"])
                        continue
                    raise ModelDownloadError(
                        f"Existing file is not the pinned artifact and was left untouched: {final.name}"
                    )
                partial_size = partial.stat().st_size if partial.is_file() else 0
                if partial_size > item["bytes"]:
                    raise ModelDownloadError(
                        f"Partial file is larger than expected and was left untouched: {partial.name}"
                    )
                remaining += int(item["bytes"]) - partial_size
            free = shutil.disk_usage(destination).free
            if free < remaining + 512 * 1024 * 1024:
                raise ModelDownloadError("Not enough free disk space for this model pair plus a 512 MiB margin.")

            completed = 0
            for item in artifacts:
                final = destination / str(item["file_name"])
                if final.exists():
                    completed += int(item["bytes"])
                    self._update(public_id, bytes_downloaded=completed)
                    continue
                self._download_artifact(public_id, item, final, completed, total)
                remember_verified_artifact(model_root, final, item["sha256"])
                completed += int(item["bytes"])
                self._update(public_id, bytes_downloaded=completed)

            self._update(
                public_id,
                state="completed",
                stage="Model body and projector are installed and hash-verified",
                file_name="",
                bytes_downloaded=total,
                error="",
            )
        except Exception as exc:
            self._update(
                public_id,
                state="error",
                stage="Model pair installation stopped",
                error=str(exc)[:500],
            )
        finally:
            with self._lock:
                self._active_model = ""

    def _download_artifact(
        self,
        public_id: str,
        item: dict[str, Any],
        final: Path,
        completed_before: int,
        total: int,
    ) -> None:
        partial = final.with_name(final.name + ".partial")
        offset = partial.stat().st_size if partial.is_file() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        self._update(
            public_id,
            state="downloading",
            stage=f"Downloading {item['file_name']}",
            file_name=item["file_name"],
            bytes_total=total,
            bytes_downloaded=completed_before + offset,
        )
        try:
            response = self.http_get(
                item["url"],
                headers=headers,
                stream=True,
                allow_redirects=True,
                timeout=(20, 120),
            )
        except requests.RequestException as exc:
            raise ModelDownloadError(f"Download failed for {item['file_name']}.") from exc
        with response:
            if offset and response.status_code == 206:
                mode = "ab"
            elif response.status_code == 200:
                mode = "wb"
                offset = 0
            else:
                raise ModelDownloadError(
                    f"Hugging Face returned HTTP {response.status_code} for {item['file_name']}."
                )
            response.raise_for_status()
            with partial.open(mode) as handle:
                current = offset
                for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                    if not chunk:
                        continue
                    handle.write(chunk)
                    current += len(chunk)
                    if current > item["bytes"]:
                        raise ModelDownloadError(f"Downloaded file exceeded its pinned size: {item['file_name']}")
                    self._update(public_id, bytes_downloaded=completed_before + current)
                handle.flush()
                os.fsync(handle.fileno())
        if partial.stat().st_size != item["bytes"]:
            raise ModelDownloadError(f"Downloaded file has the wrong size: {item['file_name']}")
        self._update(public_id, state="verifying", stage=f"Hash-verifying {item['file_name']}")
        if not hmac.compare_digest(_sha256(partial), item["sha256"]):
            raise ModelDownloadError(f"Downloaded file failed SHA-256 verification: {item['file_name']}")
        os.replace(partial, final)
