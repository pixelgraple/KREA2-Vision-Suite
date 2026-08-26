from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable

import requests


PRODUCT_ID = "krea2-vision-suite"
UPDATE_CHANNEL = "stable"
MANIFEST_URL = (
    "https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/"
    "main/releases/latest.json"
)
RELEASE_URL_PREFIX = (
    "https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/"
    "main/releases/"
)
SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_MANIFEST_BYTES = 32 * 1024
MAX_RELEASE_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILES = 5000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024


class SuiteUpdateError(RuntimeError):
    pass


class SuiteUpdateBusy(SuiteUpdateError):
    pass


def _parse_version(value: str) -> tuple[int, int, int]:
    match = SEMVER_RE.fullmatch(str(value or "").strip())
    if not match:
        raise SuiteUpdateError("The release version is not a valid semantic version.")
    return tuple(int(part) for part in match.groups())


def detect_current_version(application_root: Path, fallback: str = "0.13.14") -> str:
    root = Path(application_root).resolve()
    for candidate in (root / "VERSION", root.parent / "VERSION"):
        try:
            value = candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if SEMVER_RE.fullmatch(value):
            return value
    _parse_version(fallback)
    return fallback


class ReleaseUpdateManager:
    """Verified, suite-wide updater for the loopback BetterDiscord companion.

    The manifest URL and release URL are code-pinned. The manifest cannot choose
    an arbitrary executable or host. A release is accepted only when its exact
    byte length and SHA-256 match, then every archive path is validated before
    the bundled noninteractive updater is launched.
    """

    def __init__(
        self,
        application_root: Path,
        *,
        current_version: str | None = None,
        update_root: Path | None = None,
        http_get: Callable = requests.get,
        process_start: Callable = subprocess.Popen,
        busy_check: Callable[[], bool] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.application_root = Path(application_root).resolve()
        self.current_version = current_version or detect_current_version(self.application_root)
        _parse_version(self.current_version)
        local_app_data = Path(os.environ.get("LOCALAPPDATA") or self.application_root)
        self.update_root = Path(update_root or local_app_data / "Krea2VisionSuite" / "updates").resolve()
        self.http_get = http_get
        self.process_start = process_start
        self.busy_check = busy_check or (lambda: False)
        self.sleep = sleep
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._maintenance = False
        self._manifest: dict | None = None
        self._state = {
            "state": "idle",
            "error": "",
            "bytes_downloaded": 0,
            "bytes_total": 0,
            "progress_percent": 0.0,
            "checked_at": None,
            "latest_version": None,
            "update_available": False,
        }

    def accepting_new_jobs(self) -> bool:
        with self._lock:
            return not self._maintenance

    def status(self) -> dict:
        with self._lock:
            payload = dict(self._state)
            payload.update(
                {
                    "product": PRODUCT_ID,
                    "channel": UPDATE_CHANNEL,
                    "current_version": self.current_version,
                    "manifest_url": MANIFEST_URL,
                    "automatic_install_supported": True,
                    "maintenance_pending": self._maintenance,
                }
            )
            return payload

    @staticmethod
    def _read_bounded_response(response, maximum: int) -> bytes:
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > maximum:
                raise SuiteUpdateError("The update response exceeded its safe size limit.")
            chunks.append(bytes(chunk))
        return b"".join(chunks)

    @staticmethod
    def _require_exact_response(response, expected_url: str) -> None:
        if getattr(response, "history", None):
            raise SuiteUpdateError("The update server attempted a redirect.")
        response_url = str(getattr(response, "url", expected_url) or expected_url)
        if response_url != expected_url:
            raise SuiteUpdateError("The update server returned an unexpected URL.")
        try:
            response.raise_for_status()
        except Exception as exc:
            raise SuiteUpdateError("The update server returned an HTTP error.") from exc

    @staticmethod
    def _validate_manifest(raw: object) -> dict:
        if not isinstance(raw, dict):
            raise SuiteUpdateError("The update manifest is malformed.")
        if raw.get("schema_version") != 1 or raw.get("product") != PRODUCT_ID:
            raise SuiteUpdateError("The update manifest identifies an unsupported product.")
        if raw.get("channel") != UPDATE_CHANNEL:
            raise SuiteUpdateError("The update manifest is not on the stable channel.")
        version = str(raw.get("version") or "").strip()
        _parse_version(version)
        expected_url = f"{RELEASE_URL_PREFIX}Krea2VisionSuite-v{version}-win64.zip"
        if str(raw.get("download_url") or "") != expected_url:
            raise SuiteUpdateError("The update manifest does not use the pinned release location.")
        digest = str(raw.get("sha256") or "").strip().lower()
        if not SHA256_RE.fullmatch(digest):
            raise SuiteUpdateError("The update manifest has an invalid SHA-256 value.")
        try:
            length = int(raw.get("bytes"))
        except (TypeError, ValueError) as exc:
            raise SuiteUpdateError("The update manifest has an invalid byte length.") from exc
        if length < 32 * 1024 or length > MAX_RELEASE_BYTES:
            raise SuiteUpdateError("The update package byte length is outside the safe range.")
        notes_url = str(raw.get("notes_url") or "")
        if notes_url and not notes_url.startswith(
            "https://github.com/pixelgraple/KREA2-Vision-Suite"
        ):
            raise SuiteUpdateError("The update notes URL is not trusted.")
        return {
            "schema_version": 1,
            "product": PRODUCT_ID,
            "channel": UPDATE_CHANNEL,
            "version": version,
            "download_url": expected_url,
            "sha256": digest,
            "bytes": length,
            "notes_url": notes_url,
            "published_at": str(raw.get("published_at") or "")[:64],
        }

    def check(self) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.status()
            self._state.update({"state": "checking", "error": ""})
        try:
            response = self.http_get(
                MANIFEST_URL,
                headers={"Accept": "application/json", "Cache-Control": "no-cache"},
                timeout=(5, 20),
                allow_redirects=False,
                stream=True,
            )
            self._require_exact_response(response, MANIFEST_URL)
            body = self._read_bounded_response(response, MAX_MANIFEST_BYTES)
            try:
                decoded = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise SuiteUpdateError("The update manifest is not valid UTF-8 JSON.") from exc
            manifest = self._validate_manifest(decoded)
            available = _parse_version(manifest["version"]) > _parse_version(self.current_version)
            with self._lock:
                self._manifest = manifest
                self._state.update(
                    {
                        "state": "available" if available else "current",
                        "error": "",
                        "checked_at": time.time(),
                        "latest_version": manifest["version"],
                        "update_available": available,
                        "bytes_total": manifest["bytes"],
                        "notes_url": manifest["notes_url"],
                    }
                )
            return self.status()
        except Exception as exc:
            message = str(exc) if isinstance(exc, SuiteUpdateError) else "The update check failed safely."
            with self._lock:
                self._state.update({"state": "error", "error": message})
            if isinstance(exc, SuiteUpdateError):
                raise
            raise SuiteUpdateError(message) from exc

    def start(self) -> dict:
        checked = self.check()
        if not checked.get("update_available"):
            return checked
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise SuiteUpdateBusy("A KREA2 Vision Suite update is already in progress.")
            manifest = dict(self._manifest or {})
            if not manifest:
                raise SuiteUpdateError("No verified update manifest is available.")
            self._state.update(
                {
                    "state": "queued",
                    "error": "",
                    "bytes_downloaded": 0,
                    "progress_percent": 0.0,
                }
            )
            self._thread = threading.Thread(
                target=self._run,
                args=(manifest,),
                daemon=True,
                name="krea2-suite-update",
            )
            self._thread.start()
        return self.status()

    def _download(self, manifest: dict) -> Path:
        self.update_root.mkdir(parents=True, exist_ok=True)
        archive = self.update_root / f"Krea2VisionSuite-v{manifest['version']}-win64.zip"
        partial = archive.with_suffix(archive.suffix + ".partial")
        response = self.http_get(
            manifest["download_url"],
            headers={"Accept": "application/zip", "Cache-Control": "no-cache"},
            timeout=(10, 60),
            allow_redirects=False,
            stream=True,
        )
        self._require_exact_response(response, manifest["download_url"])
        digest = hashlib.sha256()
        total = 0
        with partial.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > manifest["bytes"] or total > MAX_RELEASE_BYTES:
                    raise SuiteUpdateError("The update package exceeded its pinned byte length.")
                digest.update(chunk)
                handle.write(chunk)
                with self._lock:
                    self._state.update(
                        {
                            "state": "downloading",
                            "bytes_downloaded": total,
                            "progress_percent": round((total / manifest["bytes"]) * 100, 1),
                        }
                    )
        if total != manifest["bytes"] or digest.hexdigest() != manifest["sha256"]:
            raise SuiteUpdateError("The update package failed exact size or SHA-256 verification.")
        partial.replace(archive)
        return archive

    def _extract(self, archive: Path, version: str) -> Path:
        expected_root = f"Krea2VisionSuite-v{version}"
        staging = self.update_root / f"staging-{version}"
        if staging.exists():
            if staging.parent != self.update_root or not staging.name.startswith("staging-"):
                raise SuiteUpdateError("The update staging path failed validation.")
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        total = 0
        with zipfile.ZipFile(archive, "r") as bundle:
            entries = bundle.infolist()
            if not entries or len(entries) > MAX_ARCHIVE_FILES:
                raise SuiteUpdateError("The update archive has an invalid file count.")
            for entry in entries:
                if entry.flag_bits & 0x1:
                    raise SuiteUpdateError("Encrypted update archives are not supported.")
                mode = (entry.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    raise SuiteUpdateError("The update archive contains an unsafe symbolic link.")
                parts = PurePosixPath(entry.filename.replace("\\", "/")).parts
                if not parts or parts[0] != expected_root or any(part in {"", ".", ".."} for part in parts):
                    raise SuiteUpdateError("The update archive contains an unsafe path.")
                total += max(0, int(entry.file_size))
                if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                    raise SuiteUpdateError("The update archive expands beyond its safe size limit.")
                target = (staging / Path(*parts)).resolve()
                if target != staging and staging not in target.parents:
                    raise SuiteUpdateError("The update archive escaped its staging directory.")
            bundle.extractall(staging)
        source_root = staging / expected_root
        required = (
            source_root / "VERSION",
            source_root / "installer" / "Install-Krea2VisionSuite.ps1",
            source_root / "betterdiscord-plugin" / "Krea2DiscordCollector.plugin.js",
            source_root / "vision-studio" / "app" / "main.py",
        )
        if any(not path.is_file() for path in required):
            raise SuiteUpdateError("The update archive is missing required suite files.")
        if (source_root / "VERSION").read_text(encoding="utf-8").strip() != version:
            raise SuiteUpdateError("The update archive version does not match its manifest.")
        return source_root

    def _wait_until_idle(self) -> None:
        with self._lock:
            self._maintenance = True
            self._state["state"] = "waiting_for_idle"
        idle_streak = 0
        deadline = time.monotonic() + 30 * 60
        while time.monotonic() < deadline:
            try:
                busy = bool(self.busy_check())
            except Exception:
                busy = True
            if busy:
                idle_streak = 0
            else:
                idle_streak += 1
                if idle_streak >= 3:
                    return
            self.sleep(1.0)
        raise SuiteUpdateError("The update waited 30 minutes but Discord Vision never became idle.")

    def _launch_installer(self, source_root: Path) -> None:
        installer = source_root / "installer" / "Install-Krea2VisionSuite.ps1"
        arguments = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(installer),
            "-Mode",
            "Update",
            "-Model",
            "None",
            "-NonInteractive",
            "-NoDiscordRestart",
            "-SkipLlamaCppRuntime",
            "-SkipPromptTextModel",
            "-PreviousVisionPid",
            str(os.getpid()),
        ]
        creationflags = 0
        for name in ("CREATE_NEW_PROCESS_GROUP", "DETACHED_PROCESS", "CREATE_NO_WINDOW"):
            creationflags |= int(getattr(subprocess, name, 0))
        self.process_start(
            arguments,
            cwd=str(source_root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )

    def _run(self, manifest: dict) -> None:
        try:
            archive = self._download(manifest)
            source_root = self._extract(archive, manifest["version"])
            self._wait_until_idle()
            with self._lock:
                self._state.update({"state": "installing", "progress_percent": 100.0})
            self._launch_installer(source_root)
        except Exception as exc:
            message = str(exc) if isinstance(exc, SuiteUpdateError) else "The update failed safely."
            with self._lock:
                self._maintenance = False
                self._state.update({"state": "error", "error": message})
