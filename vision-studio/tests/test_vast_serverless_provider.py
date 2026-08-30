from __future__ import annotations

import json
import socket
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from app.config import settings
from app.models import factory as factory_module
from app.models.factory import provider_for
from app.models.remote_access import RemoteAccess
from app.models.remote_gateway_provider import (
    RemoteGatewayProvider,
    _PinnedTlsOriginAdapter,
    fetch_remote_gateway_health,
)
from app.models.vast_serverless_provider import (
    VastServerlessProvider,
    VastServerlessProviderError,
)
from app.services import model_catalog as catalog


class VastServerlessProviderTests(unittest.TestCase):
    def _paths(self, root: Path) -> tuple[Path, Path]:
        python_exe = root / "vastsdk" / "Scripts" / "python.exe"
        bridge = root / "vast_serverless_client.py"
        python_exe.parent.mkdir(parents=True)
        python_exe.write_bytes(b"python")
        bridge.write_text("# bridge", encoding="utf-8")
        return python_exe, bridge

    def test_provider_sends_openai_vision_payload_without_exposing_key_on_command_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python_exe, bridge = self._paths(root)
            image = root / "sample.png"
            Image.new("RGB", (4, 4), "red").save(image)
            calls = []

            def runner(command, **kwargs):
                calls.append((command, kwargs))
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps(
                        {
                            "ok": True,
                            "result": {
                                "choices": [{"message": {"content": "visible detail"}}],
                                "usage": {"completion_tokens": 2},
                            },
                        }
                    ),
                    stderr="",
                )

            provider = VastServerlessProvider(
                endpoint="krea2-gemma26",
                api_key="s" * 32,
                model="gemma4-26b-a4b-heretic-q3-k-l",
                max_tokens=2048,
                timeout=1200,
                python_exe=python_exe,
                bridge_script=bridge,
                runner=runner,
            )
            reply = provider.with_image_text("system", "inspect", str(image), 0.1, 512)

        self.assertEqual(reply.text, "visible detail")
        command, kwargs = calls[0]
        self.assertNotIn("s" * 32, " ".join(command))
        self.assertEqual(kwargs["env"]["VAST_API_KEY"], "s" * 32)
        message = json.loads(kwargs["input"])
        self.assertEqual(message["endpoint"], "krea2-gemma26")
        self.assertEqual(message["cost"], 512)
        data_uri = message["payload"]["messages"][1]["content"][1]["image_url"]["url"]
        self.assertTrue(data_uri.startswith("data:image/png;base64,"))
        self.assertNotIn("VAST_API_KEY", kwargs["input"])

    def test_provider_fails_closed_on_bridge_error(self):
        with tempfile.TemporaryDirectory() as directory:
            python_exe, bridge = self._paths(Path(directory))
            provider = VastServerlessProvider(
                endpoint="krea2-gemma26",
                api_key="s" * 32,
                model="gemma4-26b-a4b-heretic-q3-k-l",
                max_tokens=2048,
                timeout=1200,
                python_exe=python_exe,
                bridge_script=bridge,
                runner=lambda *_args, **_kwargs: SimpleNamespace(
                    returncode=1,
                    stdout=json.dumps({"ok": False, "error": "no worker available"}),
                    stderr="",
                ),
            )
            with self.assertRaisesRegex(VastServerlessProviderError, "no worker available"):
                provider.text("system", "prompt", 0.1)

    def test_remote_gateway_preserves_configured_cold_start_timeout(self):
        access_kwargs={
            "license_id":"lic_" + "x" * 18,
            "license_token":"t" * 48,
            "request_id":"a" * 64,
        }
        if "discord_user_id" in RemoteAccess.__dataclass_fields__:
            access_kwargs.update(
                discord_user_id="123456789012345678",
                discord_username="test-user",
            )
        provider = RemoteGatewayProvider(
            base_url="https://vision.example.test",
            model="gemma4-26b-a4b-heretic-q3-k-l",
            max_tokens=2048,
            timeout=2700,
            access=RemoteAccess(**access_kwargs),
        )
        self.assertEqual(provider.timeout, 2700.0)

    def test_pinned_origin_enables_bounded_tcp_keepalives(self):
        adapter = _PinnedTlsOriginAdapter("192.0.2.10", "vision.example.test")
        options = adapter.poolmanager.connection_pool_kw["socket_options"]
        self.assertIn((socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1), options)
        for name, value in (("TCP_KEEPIDLE", 30), ("TCP_KEEPINTVL", 15), ("TCP_KEEPCNT", 4)):
            option = getattr(socket, name, None)
            if option is not None:
                self.assertIn((socket.IPPROTO_TCP, option, value), options)

    def test_remote_gateway_health_returns_secret_free_capacity_state(self):
        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "ok": True,
                    "remote_ready": False,
                    "remote_cold_start_eligible": True,
                    "remote_inactive_workers": 1,
                    "remote_allowed_gpu_names": ["RTX 3090", "RTX 4090"],
                }

        class Http:
            calls = []

            @classmethod
            def get(cls, url, **kwargs):
                cls.calls.append((url, kwargs))
                return Response()

        health = fetch_remote_gateway_health(
            "https://vision.example.test/api/krea2-vision",
            http=Http,
        )
        self.assertTrue(health["remote_cold_start_eligible"])
        self.assertEqual(health["remote_inactive_workers"], 1)
        self.assertEqual(Http.calls, [("https://vision.example.test/api/krea2-vision/health", {"timeout": 12})])

    def test_catalog_exposes_only_fully_configured_opt_in_remote_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python_exe, _ = self._paths(root)
            checked_in_bridge = root / "app" / "models" / "vast_serverless_client.py"
            checked_in_bridge.parent.mkdir(parents=True)
            checked_in_bridge.write_text("# bridge", encoding="utf-8")
            configured = replace(
                settings,
                vast_serverless_enabled=True,
                vast_serverless_endpoint="krea2-gemma26",
                vast_serverless_api_key="s" * 32,
                vast_serverless_python_exe=str(python_exe),
                vast_serverless_model_id="vast::gemma4-26b-a4b-heretic-q3_k_l",
                remote_gateway_url="https://seedframe.xyz/api/krea2-vision",
            )
            with patch.object(catalog, "ROOT", root):
                specs = catalog.available_vast_serverless_specs(configured)
                disabled = catalog.available_vast_serverless_specs(
                    replace(configured, vast_serverless_enabled=False)
                )
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].backend, "vast_serverless")
        self.assertFalse(specs[0].local_gpu)
        self.assertEqual(specs[0].estimated_vram_mb, 18432)
        self.assertEqual(disabled, [])

    def test_factory_selects_licensed_remote_gateway_provider(self):
        spec = catalog.ModelSpec(
            "vast::gemma4-26b-a4b-heretic-q3_k_l",
            "dedicated RTX 3090",
            "vast_serverless",
            "gemma4-26b-a4b-heretic-q3-k-l",
            False,
            8192,
            2048,
            18432,
        )
        configured = replace(
            settings,
            remote_gateway_url="https://seedframe.xyz/api/krea2-vision",
            vast_serverless_request_timeout_seconds=1200,
        )
        access=RemoteAccess(
            license_id="lic_" + "x" * 18,
            license_token="t" * 48,
            discord_user_id="123456789012345678",
            discord_username="test-user",
            request_id="a" * 64,
        )
        with patch.object(factory_module, "RemoteGatewayProvider", return_value="remote") as create:
            self.assertEqual(provider_for(configured, spec, remote_access=access), "remote")
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["model"], spec.provider_model)
        self.assertEqual(kwargs["base_url"], "https://seedframe.xyz/api/krea2-vision")
        self.assertEqual(kwargs["origin_ip"], settings.remote_gateway_origin_ip)
        self.assertEqual(kwargs["max_tokens"], 2048)
        self.assertEqual(kwargs["access"], access)


if __name__ == "__main__":
    unittest.main()
