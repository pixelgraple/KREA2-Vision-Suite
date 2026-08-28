from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.services.release_updates import (
    MANIFEST_URL,
    RELEASE_URL_PREFIX,
    ReleaseUpdateManager,
    SuiteUpdateError,
)


class FakeResponse:
    def __init__(self, url: str, body: bytes, status: int = 200) -> None:
        self.url = url
        self.body = body
        self.status_code = status
        self.history = []

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size: int):
        for offset in range(0, len(self.body), max(1, chunk_size)):
            yield self.body[offset : offset + chunk_size]


def make_release(version: str, *, traversal: bool = False) -> bytes:
    buffer = io.BytesIO()
    root = f"Krea2VisionSuite-v{version}"
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(f"{root}/VERSION", f"{version}\n")
        bundle.writestr(f"{root}/installer/Install-Krea2VisionSuite.ps1", "Write-Host update")
        bundle.writestr(f"{root}/betterdiscord-plugin/Krea2DiscordCollector.plugin.js", os.urandom(40_000))
        bundle.writestr(f"{root}/vision-studio/app/main.py", "app = None")
        if traversal:
            bundle.writestr(f"{root}/../escaped.txt", "unsafe")
    return buffer.getvalue()


def manifest(version: str, release: bytes, **overrides) -> bytes:
    payload = {
        "schema_version": 1,
        "product": "krea2-vision-suite",
        "channel": "stable",
        "version": version,
        "published_at": "2026-08-25T00:00:00Z",
        "download_url": f"{RELEASE_URL_PREFIX}Krea2VisionSuite-v{version}-win64.zip",
        "sha256": hashlib.sha256(release).hexdigest(),
        "bytes": len(release),
        "notes_url": "https://github.com/pixelgraple/KREA2-Vision-Suite#download",
    }
    payload.update(overrides)
    return json.dumps(payload).encode("utf-8")


class ReleaseUpdateManagerTests(unittest.TestCase):
    def test_non_windows_install_is_reported_and_fails_before_download(self):
        release = make_release("1.2.4")
        body = manifest("1.2.4", release)
        calls = []

        def get(url, **_kwargs):
            calls.append(url)
            return FakeResponse(url, body)

        with tempfile.TemporaryDirectory() as temporary:
            manager = ReleaseUpdateManager(
                Path(temporary),
                current_version="1.2.3",
                update_root=Path(temporary) / "updates",
                http_get=get,
                automatic_install_supported=False,
            )
            self.assertFalse(manager.status()["automatic_install_supported"])
            with self.assertRaisesRegex(SuiteUpdateError, "Linux/macOS shell installer"):
                manager.start()
        self.assertEqual(calls, [MANIFEST_URL])

    def test_verified_release_launches_only_bundled_update_mode(self):
        version = "1.2.4"
        release = make_release(version)
        manifest_body = manifest(version, release)
        calls = []

        def get(url, **kwargs):
            self.assertFalse(kwargs["allow_redirects"])
            if url == MANIFEST_URL:
                return FakeResponse(url, manifest_body)
            return FakeResponse(url, release)

        def start(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return object()

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = ReleaseUpdateManager(
                root,
                current_version="1.2.3",
                update_root=root / "updates",
                http_get=get,
                process_start=start,
                sleep=lambda _seconds: None,
            )
            queued = manager.start()
            self.assertEqual(queued["state"], "queued")
            manager._thread.join(timeout=5)
            self.assertFalse(manager._thread.is_alive())
            status = manager.status()

        self.assertEqual(status["state"], "installing")
        self.assertTrue(status["maintenance_pending"])
        self.assertEqual(len(calls), 1)
        arguments, options = calls[0]
        self.assertIn("Update", arguments)
        self.assertIn("-SkipLlamaCppRuntime", arguments)
        self.assertIn("-SkipPromptTextModel", arguments)
        self.assertIn("-PreviousVisionPid", arguments)
        self.assertEqual(options["stdin"], -3)

    def test_current_release_does_not_download_or_launch(self):
        release = make_release("1.2.3")
        body = manifest("1.2.3", release)
        calls = []

        def get(url, **_kwargs):
            calls.append(url)
            return FakeResponse(url, body)

        with tempfile.TemporaryDirectory() as temporary:
            manager = ReleaseUpdateManager(
                Path(temporary),
                current_version="1.2.3",
                update_root=Path(temporary) / "updates",
                http_get=get,
                process_start=lambda *_a, **_k: self.fail("installer must not start"),
            )
            status = manager.start()
        self.assertEqual(status["state"], "current")
        self.assertFalse(status["update_available"])
        self.assertEqual(calls, [MANIFEST_URL])

    def test_manifest_cannot_select_another_download_host(self):
        release = make_release("1.2.4")
        body = manifest("1.2.4", release, download_url="https://attacker.example/update.zip")
        with tempfile.TemporaryDirectory() as temporary:
            manager = ReleaseUpdateManager(
                Path(temporary),
                current_version="1.2.3",
                update_root=Path(temporary) / "updates",
                http_get=lambda url, **_kwargs: FakeResponse(url, body),
            )
            with self.assertRaisesRegex(SuiteUpdateError, "pinned release location"):
                manager.check()

    def test_wrong_release_hash_fails_before_extraction(self):
        release = make_release("1.2.4")
        body = manifest("1.2.4", release, sha256="0" * 64)

        def get(url, **_kwargs):
            return FakeResponse(url, body if url == MANIFEST_URL else release)

        with tempfile.TemporaryDirectory() as temporary:
            manager = ReleaseUpdateManager(
                Path(temporary),
                current_version="1.2.3",
                update_root=Path(temporary) / "updates",
                http_get=get,
                sleep=lambda _seconds: None,
            )
            manager.start()
            manager._thread.join(timeout=5)
            status = manager.status()
        self.assertEqual(status["state"], "error")
        self.assertIn("SHA-256", status["error"])
        self.assertFalse(status["maintenance_pending"])

    def test_archive_traversal_is_rejected_before_install(self):
        release = make_release("1.2.4", traversal=True)
        body = manifest("1.2.4", release)

        def get(url, **_kwargs):
            return FakeResponse(url, body if url == MANIFEST_URL else release)

        with tempfile.TemporaryDirectory() as temporary:
            manager = ReleaseUpdateManager(
                Path(temporary),
                current_version="1.2.3",
                update_root=Path(temporary) / "updates",
                http_get=get,
                process_start=lambda *_a, **_k: self.fail("installer must not start"),
                sleep=lambda _seconds: None,
            )
            manager.start()
            manager._thread.join(timeout=5)
            status = manager.status()
        self.assertEqual(status["state"], "error")
        self.assertIn("unsafe path", status["error"])


if __name__ == "__main__":
    unittest.main()
