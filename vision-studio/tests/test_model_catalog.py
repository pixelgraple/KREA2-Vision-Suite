from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from unittest.mock import Mock, patch

from app.config import settings
from app.services import model_catalog as catalog


def _artifact(path: Path, relative_path: str, content: bytes) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return {
        "file_name": path.name,
        "relative_path": relative_path,
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def _verified_bundle(
    root: Path,
    *,
    projector_as_list: bool = True,
):
    server_exe = root / "runtime" / "llama-server.exe"
    server_exe.parent.mkdir(parents=True)
    server_exe.write_bytes(b"test executable")
    model_root = root / "models"
    model_root.mkdir()
    entries = []
    for definition in catalog.LLAMA_CPP_DEFINITIONS:
        model_content = f"model:{definition.manifest_id}".encode()
        projector_content = f"projector:{definition.manifest_id}".encode()
        model = _artifact(
            model_root.joinpath(*definition.model_relative_path.split("/")),
            definition.model_relative_path,
            model_content,
        )
        projectors = [
            _artifact(
                model_root.joinpath(*definition.mmproj_relative_paths[index].split("/")),
                definition.mmproj_relative_paths[index],
                projector_content + f":{index}".encode(),
            )
            for index in (0,)
        ]
        entries.append(
            {
                "public_id": definition.manifest_id,
                "model": model,
                "mmproj": projectors if projector_as_list else projectors[0],
            }
        )
    manifest = root / "scripts" / "heretic_llamacpp_artifacts.json"
    manifest.parent.mkdir()
    manifest.write_text(
        json.dumps({"version": 1, "bundle_id": "test", "models": entries}),
        encoding="utf-8",
    )
    configured = replace(
        settings,
        api_base="http://ollama.invalid",
        llama_cpp_server_exe=str(server_exe),
        llama_cpp_model_root=str(model_root),
        llama_cpp_artifact_manifest="scripts/heretic_llamacpp_artifacts.json",
        llama_cpp_port=8091,
        llama_cpp_context_cap=4096,
    )
    return configured, entries, model_root, manifest


class ModelCatalogTests(unittest.TestCase):
    def setUp(self):
        catalog._sha256_for_fingerprint.cache_clear()

    def test_installed_qwen_compatibility_remains_raw_ollama_tags(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "models": [{"name": "qwen3-vl:8b"}, {"name": "not-supported"}]
        }
        with patch.object(catalog.requests, "get", return_value=response):
            self.assertEqual(
                catalog.installed_qwen3_vl("http://127.0.0.1:11434"),
                [("Fast — Qwen3-VL 8B", "qwen3-vl:8b")],
            )

    def test_llama_models_require_verified_body_and_one_projector(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, _, _, _ = _verified_bundle(root)
            with patch.object(catalog, "ROOT", root):
                specs = catalog.available_llama_cpp_specs(configured)
            self.assertEqual(
                [item.public_id for item in specs],
                [
                    "llamacpp::heretic-2b-f16",
                    "llamacpp::heretic-4b-q8_0",
                    "llamacpp::heretic-8b-q8_0",
                    "llamacpp::glm4-9b-abliterated-q5_k_m",
                    "llamacpp::gemma4-12b-opus-uncensored-q8_0",
                    "llamacpp::gemma4-12b-heretic-q8_0",
                    "llamacpp::gemma4-26b-a4b-heretic-q3_k_l",
                    "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k",
                    "llamacpp::gemma4-31b-heretic-q4_k_m",
                    "llamacpp::qwen3-vl-32b-heretic-q4_k_m",
                ],
            )
            self.assertEqual(
                [item.estimated_vram_mb for item in specs],
                [6144, 7680, 13312, 12288, 20992, 20992, 24576, 18432, 24576, 26624],
            )
            self.assertTrue(all(item.context_cap == 4096 for item in specs))
            self.assertTrue(all(item.server_exe and item.model_path and item.mmproj_path for item in specs))

    def test_original_single_projector_manifest_shape_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, _, _, _ = _verified_bundle(root, projector_as_list=False)
            with patch.object(catalog, "ROOT", root):
                self.assertEqual(len(catalog.available_llama_cpp_specs(configured)), 10)

    def test_persistent_fingerprint_cache_avoids_rehash_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, _, model_root, _ = _verified_bundle(root)
            with patch.object(catalog, "ROOT", root):
                self.assertEqual(len(catalog.available_llama_cpp_specs(configured)), 10)
                self.assertTrue(
                    (model_root / catalog._VERIFIED_ARTIFACT_CACHE_NAME).is_file()
                )
                catalog._sha256_for_fingerprint.cache_clear()
                with patch.object(
                    catalog,
                    "_sha256_for_fingerprint",
                    side_effect=AssertionError("persistent cache should avoid a full rehash"),
                ):
                    self.assertEqual(len(catalog.available_llama_cpp_specs(configured)), 10)

    def test_persistent_fingerprint_cache_does_not_mask_same_size_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, entries, model_root, _ = _verified_bundle(root)
            with patch.object(catalog, "ROOT", root):
                self.assertEqual(len(catalog.available_llama_cpp_specs(configured)), 10)
                changed_relative = entries[0]["model"]["relative_path"]
                changed_path = model_root.joinpath(*str(changed_relative).split("/"))
                original = changed_path.read_bytes()
                changed_path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
                catalog._sha256_for_fingerprint.cache_clear()
                specs = catalog.available_llama_cpp_specs(configured)
            self.assertNotIn(
                "llamacpp::heretic-2b-f16", [item.public_id for item in specs]
            )

    def test_only_each_models_pinned_projector_is_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, _, _, _ = _verified_bundle(root)
            with patch.object(catalog, "ROOT", root):
                specs = catalog.available_llama_cpp_specs(configured)
            self.assertEqual(len(specs), 10)
            self.assertEqual(
                [item.mmproj_path.name for item in specs],
                [
                    "Qwen-3-VL-2B-Instruct-heretic.mmproj-Q8_0.gguf",
                    "Qwen3-VL-4B-Instruct-heretic.mmproj-Q8_0.gguf",
                    "Qwen-3-VL-8B-Instruct-heretic.mmproj-Q8_0.gguf",
                    "Huihui-GLM-4.6V-Flash-abliterated.mmproj-Q8_0.gguf",
                    "mmproj-gemma-4-12B-it-Q8_0.gguf",
                    "gemma-4-12B-it-uncensored-heretic-mmproj-BF16.gguf",
                    "gemma-4-26B-A4B-it-mmproj-BF16.gguf",
                    "Qwen3-VL-30B-A3B-Instruct-abliterated.mmproj-Q8_0.gguf",
                    "gemma-4-31B-it-mmproj-BF16.gguf",
                    "Qwen3-VL-32B-Instruct-mmproj-BF16.gguf",
                ],
            )

    def test_invalid_q8_projector_hides_only_the_affected_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, entries, model_root, _ = _verified_bundle(root)
            q8_relative = entries[0]["mmproj"][0]["relative_path"]
            q8_path = model_root.joinpath(*str(q8_relative).split("/"))
            q8_path.write_bytes(b"tampered q8 projector")
            with patch.object(catalog, "ROOT", root):
                specs = catalog.available_llama_cpp_specs(configured)
            self.assertEqual(
                [item.public_id for item in specs],
                [
                    "llamacpp::heretic-4b-q8_0",
                    "llamacpp::heretic-8b-q8_0",
                    "llamacpp::glm4-9b-abliterated-q5_k_m",
                    "llamacpp::gemma4-12b-opus-uncensored-q8_0",
                    "llamacpp::gemma4-12b-heretic-q8_0",
                    "llamacpp::gemma4-26b-a4b-heretic-q3_k_l",
                    "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k",
                    "llamacpp::gemma4-31b-heretic-q4_k_m",
                    "llamacpp::qwen3-vl-32b-heretic-q4_k_m",
                ],
            )

    def test_hash_or_size_mismatch_hides_only_the_affected_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, entries, model_root, _ = _verified_bundle(root)
            bad_relative = entries[1]["model"]["relative_path"]
            bad_path = model_root.joinpath(*str(bad_relative).split("/"))
            original = bad_path.read_bytes()
            bad_path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            with patch.object(catalog, "ROOT", root):
                specs = catalog.available_llama_cpp_specs(configured)
            self.assertEqual(
                [item.public_id for item in specs],
                [
                    "llamacpp::heretic-2b-f16",
                    "llamacpp::heretic-8b-q8_0",
                    "llamacpp::glm4-9b-abliterated-q5_k_m",
                    "llamacpp::gemma4-12b-opus-uncensored-q8_0",
                    "llamacpp::gemma4-12b-heretic-q8_0",
                    "llamacpp::gemma4-26b-a4b-heretic-q3_k_l",
                    "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k",
                    "llamacpp::gemma4-31b-heretic-q4_k_m",
                    "llamacpp::qwen3-vl-32b-heretic-q4_k_m",
                ],
            )

    def test_missing_runtime_or_manifest_outside_checkout_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, _, _, manifest = _verified_bundle(root)
            configured = replace(configured, llama_cpp_server_exe=str(root / "missing.exe"))
            with patch.object(catalog, "ROOT", root):
                self.assertEqual(catalog.available_llama_cpp_specs(configured), [])

            external = root.parent / f"{root.name}-external-manifest.json"
            try:
                external.write_bytes(manifest.read_bytes())
                configured = replace(
                    configured,
                    llama_cpp_server_exe=str(root / "runtime" / "llama-server.exe"),
                    llama_cpp_artifact_manifest=str(external),
                )
                with patch.object(catalog, "ROOT", root):
                    self.assertEqual(catalog.available_llama_cpp_specs(configured), [])
            finally:
                external.unlink(missing_ok=True)

    def test_public_status_and_repr_never_expose_server_paths_or_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured, entries, _, _ = _verified_bundle(root)
            with patch.object(catalog, "ROOT", root), patch.object(
                catalog, "_installed_ollama_names", return_value=set()
            ):
                specs = catalog.available_model_specs(configured)
                status = catalog.public_model_statuses(configured)
            serialized = json.dumps(status)
            self.assertNotIn(str(root), serialized)
            self.assertNotIn(".gguf", serialized)
            self.assertNotIn(entries[0]["model"]["sha256"], serialized)
            self.assertNotIn(str(root), repr(specs[0]))
            self.assertEqual(
                set(status[0]),
                {
                    "public_id",
                    "label",
                    "backend",
                    "local_gpu",
                    "context_cap",
                    "max_output_cap",
                    "estimated_vram_mb",
                },
            )

    def test_model_spec_is_immutable_and_resolution_rejects_unknown_or_unavailable(self):
        with patch.object(catalog, "_installed_ollama_names", return_value={"qwen3-vl:8b"}):
            configured = replace(
                settings,
                llama_cpp_server_exe="",
                llama_cpp_model_root="",
                llama_cpp_artifact_manifest="",
            )
            resolved = catalog.resolve_model("qwen3-vl:8b", configured)
            self.assertEqual(resolved.public_id, "ollama::qwen3-vl:8b")
            self.assertEqual(resolved.provider_model, "qwen3-vl:8b")
            self.assertEqual(
                catalog.resolve_model("ollama::qwen3-vl:8b", configured), resolved
            )
            with self.assertRaises(catalog.ModelUnavailableError):
                catalog.resolve_model("ollama::qwen3-vl:30b", configured)
            with self.assertRaises(catalog.UnknownModelError):
                catalog.resolve_model("ollama::not-real", configured)
            with self.assertRaises(FrozenInstanceError):
                resolved.label = "changed"


if __name__ == "__main__":
    unittest.main()
