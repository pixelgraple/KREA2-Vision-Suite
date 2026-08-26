from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from app.config import settings
from app.services.model_downloads import ModelDownloadError, ModelDownloadManager
from app.services.model_catalog import _VERIFIED_ARTIFACT_CACHE_NAME


class FakeResponse:
    def __init__(self, data: bytes, status_code: int = 200) -> None:
        self.data = data
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size: int):
        for offset in range(0, len(self.data), max(1, chunk_size)):
            yield self.data[offset : offset + chunk_size]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ModelDownloadManagerTests(unittest.TestCase):
    def make_manager(self, root: Path, body: bytes, projector: bytes, http_get):
        manifest = {
            "models": [
                {
                    "public_id": "qwen3-vl-heretic-2b-f16",
                    "directory": "2B",
                    "model": {
                        "relative_path": "2B/model.gguf",
                        "url": "https://huggingface.co/example/model.gguf",
                        "bytes": len(body),
                        "sha256": sha256(body),
                    },
                    "mmproj": [
                        {
                            "relative_path": "2B/mmproj.gguf",
                            "url": "https://huggingface.co/example/mmproj.gguf",
                            "bytes": len(projector),
                            "sha256": sha256(projector),
                        }
                    ],
                }
            ]
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        configured = replace(
            settings,
            llama_cpp_model_root=str(root / "models"),
            llama_cpp_artifact_manifest=str(manifest_path),
        )
        return ModelDownloadManager(configured, http_get=http_get)

    @staticmethod
    def finish(manager: ModelDownloadManager) -> dict:
        manager._thread.join(timeout=5)
        if manager._thread.is_alive():
            raise AssertionError("model download worker did not finish")
        return manager.status("llamacpp::heretic-2b-f16")

    def test_installs_body_and_projector_in_same_folder(self):
        body = b"verified model body"
        projector = b"verified projector"
        payloads = {
            "https://huggingface.co/example/model.gguf": body,
            "https://huggingface.co/example/mmproj.gguf": projector,
        }

        def get(url, **kwargs):
            self.assertEqual(kwargs["headers"], {})
            return FakeResponse(payloads[url])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = self.make_manager(root, body, projector, get)
            manager.start("llamacpp::heretic-2b-f16")
            status = self.finish(manager)
            folder = root / "models" / "2B"
            self.assertEqual(status["state"], "completed")
            self.assertEqual((folder / "model.gguf").read_bytes(), body)
            self.assertEqual((folder / "mmproj.gguf").read_bytes(), projector)
            self.assertFalse((folder / "model.gguf.partial").exists())
            self.assertEqual(status["bytes_downloaded"], len(body) + len(projector))
            self.assertEqual(status["progress_percent"], 100.0)
            cache = json.loads(
                (root / "models" / _VERIFIED_ARTIFACT_CACHE_NAME).read_text(encoding="utf-8")
            )
            self.assertEqual(set(cache["artifacts"]), {"2B/model.gguf", "2B/mmproj.gguf"})

    def test_resumes_partial_artifact_and_verifies_final_hash(self):
        body = b"0123456789"
        projector = b"projector"
        seen_headers = []

        def get(url, **kwargs):
            seen_headers.append((url, dict(kwargs["headers"])))
            if url.endswith("model.gguf"):
                return FakeResponse(body[4:], 206)
            return FakeResponse(projector)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = self.make_manager(root, body, projector, get)
            folder = root / "models" / "2B"
            folder.mkdir(parents=True)
            (folder / "model.gguf.partial").write_bytes(body[:4])
            manager.start("llamacpp::heretic-2b-f16")
            status = self.finish(manager)
            self.assertEqual(status["state"], "completed")
            self.assertEqual((folder / "model.gguf").read_bytes(), body)
            self.assertIn(
                ("https://huggingface.co/example/model.gguf", {"Range": "bytes=4-"}),
                seen_headers,
            )

    def test_invalid_existing_file_is_preserved_and_reported(self):
        body = b"expected"
        projector = b"projector"

        def get(_url, **_kwargs):
            raise AssertionError("network must not start when an invalid final file exists")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = self.make_manager(root, body, projector, get)
            folder = root / "models" / "2B"
            folder.mkdir(parents=True)
            invalid = folder / "model.gguf"
            invalid.write_bytes(b"user file")
            manager.start("llamacpp::heretic-2b-f16")
            status = self.finish(manager)
            self.assertEqual(status["state"], "error")
            self.assertIn("left untouched", status["error"])
            self.assertEqual(invalid.read_bytes(), b"user file")

    def test_unknown_model_is_rejected_before_thread_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            manager = self.make_manager(Path(temporary), b"body", b"projector", lambda *_a, **_k: None)
            with self.assertRaises(ModelDownloadError):
                manager.start("llamacpp::not-pinned")


if __name__ == "__main__":
    unittest.main()
