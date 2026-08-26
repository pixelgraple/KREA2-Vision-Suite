from __future__ import annotations

import base64
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import requests
from PIL import Image

from app.models.llama_cpp_provider import LlamaCppProvider, LlamaCppProviderError
from app.services.gpu_telemetry import (
    GpuMemory,
    GpuTelemetryError,
    MeasuredPeakStore,
    PeakMeasurement,
    PeakMemoryPoller,
    query_gpu_memory,
)


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class FakeHttp:
    def __init__(self, health_status=200):
        self.health_status = health_status
        self.posts = []

    def get(self, *_, **__):
        return FakeResponse(self.health_status, {"status": "ok"})

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return FakeResponse(
            200,
            {
                "choices": [{"message": {"content": '{"answer":"visible detail"}'}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4},
            },
        )


class FakeProcess:
    def __init__(self, terminate_stops=True):
        self.pid = 4321
        self.alive = True
        self.terminate_stops = terminate_stops
        self.terminate_calls = 0
        self.kill_calls = 0
        self.wait_calls = 0

    def poll(self):
        return None if self.alive else 0

    def terminate(self):
        self.terminate_calls += 1
        if self.terminate_stops:
            self.alive = False

    def kill(self):
        self.kill_calls += 1
        self.alive = False

    def wait(self, timeout=None):
        self.wait_calls += 1
        if self.alive:
            raise subprocess.TimeoutExpired("llama-server", timeout)
        return 0


class AdvancingClock:
    def __init__(self, step=0.2):
        self.value = 0.0
        self.step = step

    def __call__(self):
        current = self.value
        self.value += self.step
        return current


class LlamaCppProviderTests(unittest.TestCase):
    def files(self, root: Path):
        server = root / "llama-server.exe"
        model = root / "model.gguf"
        mmproj = root / "mmproj.gguf"
        for path in (server, model, mmproj):
            path.write_bytes(b"test")
        return server, model, mmproj

    def test_loopback_process_arguments_chat_contract_and_idempotent_teardown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server, model, mmproj = self.files(root)
            image = root / "reference.png"
            image.write_bytes(b"png-bytes")
            process = FakeProcess()
            launch = {}
            events = []

            def popen(command, **kwargs):
                launch["command"] = command
                launch["kwargs"] = kwargs
                return process

            http = FakeHttp()
            provider = LlamaCppProvider(
                server,
                model,
                mmproj,
                "llamacpp:heretic-8b-q8_0",
                port=18435,
                context=16384,
                max_tokens=4096,
                api_key="k" * 32,
                telemetry_callback=lambda event, payload: events.append((event, payload)),
                runtime_log_path=root / "logs" / "llama-server.log",
                http=http,
                popen_factory=popen,
                sleeper=lambda _: None,
            )
            reply = provider.with_image("system", "inspect", str(image), 0.1)
            plain_reply = provider.with_image_text(
                "system", "describe in prose", str(image), 0.1, 1536
            )
            capped_reply = provider.with_image_text(
                "system", "describe with capped output", str(image), 0.1, 9999
            )
            with self.assertRaises(LlamaCppProviderError):
                provider.with_image_text("system", "invalid limit", str(image), 0.1, 0)
            text_reply = provider.text("system", "merge", 0.2, 512)

            command = launch["command"]
            self.assertIsInstance(command, list)
            self.assertEqual(command[0], str(server))
            self.assertIn("--parallel", command)
            self.assertEqual(command[command.index("--flash-attn") + 1], "on")
            self.assertEqual(command[command.index("--cache-ram") + 1], "0")
            self.assertEqual(command[command.index("--image-max-tokens") + 1], "4096")
            self.assertEqual(command[command.index("--parallel") + 1], "1")
            self.assertEqual(command[command.index("--n-gpu-layers") + 1], "all")
            self.assertIn("--mmproj-offload", command)
            self.assertEqual(
                command[command.index("--log-file") + 1],
                str(root / "logs" / "llama-server.log"),
            )
            self.assertIn("--log-timestamps", command)
            self.assertEqual(command[command.index("--reasoning") + 1], "off")
            self.assertEqual(command[command.index("--reasoning-format") + 1], "none")
            self.assertEqual(command[command.index("--reasoning-budget") + 1], "0")
            self.assertEqual(command[command.index("--host") + 1], "127.0.0.1")
            self.assertFalse(launch["kwargs"]["shell"])
            self.assertEqual(reply.text, '{"answer":"visible detail"}')
            self.assertEqual(plain_reply.text, '{"answer":"visible detail"}')
            self.assertEqual(capped_reply.text, '{"answer":"visible detail"}')
            self.assertEqual(text_reply.metrics["completion_tokens"], 4)

            image_request = http.posts[0][1]
            self.assertEqual(image_request["json"]["response_format"], {"type": "json_object"})
            content = image_request["json"]["messages"][1]["content"]
            self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))
            self.assertEqual(image_request["headers"], {"Authorization": "Bearer " + "k" * 32})
            self.assertNotIn("response_format",http.posts[1][1]["json"])
            self.assertEqual(http.posts[1][1]["json"]["max_tokens"], 1536)
            self.assertEqual(http.posts[2][1]["json"]["max_tokens"], 4096)
            self.assertEqual(http.posts[3][1]["json"]["max_tokens"], 512)

            provider.unload()
            provider.unload()
            self.assertEqual(process.terminate_calls, 1)
            self.assertEqual(process.kill_calls, 0)
            self.assertEqual([event for event, _ in events], ["starting", "ready", "stopping", "stopped"])
            serialized_events = json.dumps(events)
            self.assertNotIn(str(root), serialized_events)
            self.assertNotIn("model.gguf", serialized_events)
            self.assertNotIn("k" * 32, serialized_events)

    def test_reasoning_content_is_used_when_standard_content_is_empty(self):
        class ReasoningHttp(FakeHttp):
            def post(self, url, **kwargs):
                self.posts.append((url, kwargs))
                return FakeResponse(200, {
                    "choices": [{"message": {"content": "", "reasoning_content": "visible prose"}}],
                    "usage": {},
                })

        with tempfile.TemporaryDirectory() as temporary:
            server, model, mmproj = self.files(Path(temporary))
            provider = LlamaCppProvider(
                server,
                model,
                mmproj,
                "llamacpp:heretic-8b-q8_0",
                api_key="r" * 32,
                http=ReasoningHttp(),
                popen_factory=lambda *_args, **_kwargs: FakeProcess(),
                sleeper=lambda _: None,
            )
            self.assertEqual(provider.text("system", "prompt", 0.1).text, "visible prose")
            provider.unload()

    def test_unload_kills_exact_child_after_graceful_timeout(self):
        with tempfile.TemporaryDirectory() as temporary:
            server, model, mmproj = self.files(Path(temporary))
            process = FakeProcess(terminate_stops=False)
            provider = LlamaCppProvider(
                server,
                model,
                mmproj,
                "llamacpp:heretic-4b-q8_0",
                api_key="a" * 32,
                http=FakeHttp(),
                popen_factory=lambda *_args, **_kwargs: process,
                sleeper=lambda _: None,
            )
            provider.unload()
            self.assertEqual(process.terminate_calls, 1)
            self.assertEqual(process.kill_calls, 1)
            self.assertFalse(process.alive)

    def test_gemma_projector_can_stay_on_cpu_with_bounded_image_tokens(self):
        with tempfile.TemporaryDirectory() as temporary:
            server, model, mmproj = self.files(Path(temporary))
            launch = {}

            def popen(command, **_kwargs):
                launch["command"] = command
                return FakeProcess()

            provider = LlamaCppProvider(
                server,
                model,
                mmproj,
                "gemma4-12b-heretic-q8-0",
                api_key="g" * 32,
                mmproj_offload=False,
                image_min_tokens=256,
                image_max_tokens=256,
                image_max_side=768,
                gpu_layers=40,
                http=FakeHttp(),
                popen_factory=popen,
                sleeper=lambda _: None,
            )
            command = launch["command"]
            self.assertIn("--no-mmproj-offload", command)
            self.assertNotIn("--mmproj-offload", command)
            self.assertEqual(command[command.index("--image-min-tokens") + 1], "256")
            self.assertEqual(command[command.index("--image-max-tokens") + 1], "256")
            self.assertEqual(command[command.index("--n-gpu-layers") + 1], "40")

            image = Path(temporary) / "large-reference.png"
            Image.new("RGB", (1200, 1800), "white").save(image)
            provider.with_image_text("system", "inspect", str(image), 0.1)
            data_uri = provider.http.posts[0][1]["json"]["messages"][1]["content"][1]["image_url"]["url"]
            self.assertTrue(data_uri.startswith("data:image/jpeg;base64,"))
            resized = Image.open(io.BytesIO(base64.b64decode(data_uri.split(",", 1)[1])))
            self.assertEqual(resized.size, (512, 768))
            provider.unload()

    def test_adaptive_fit_leaves_gpu_layers_unset_and_preserves_four_gib_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            server, model, mmproj = self.files(Path(temporary))
            launch = {}

            def popen(command, **_kwargs):
                launch["command"] = command
                return FakeProcess()

            provider = LlamaCppProvider(
                server,
                model,
                mmproj,
                "gemma4-12b-heretic-q8-0",
                context=8192,
                max_tokens=2048,
                api_key="f" * 32,
                mmproj_offload=False,
                image_min_tokens=256,
                image_max_tokens=256,
                gpu_layers="auto",
                fit_target_mb=4096,
                http=FakeHttp(),
                popen_factory=popen,
                sleeper=lambda _: None,
            )
            command = launch["command"]
            self.assertNotIn("--n-gpu-layers", command)
            self.assertEqual(command[command.index("--fit") + 1], "on")
            self.assertEqual(command[command.index("--fit-target") + 1], "4096")
            self.assertEqual(command[command.index("--fit-ctx") + 1], "8192")
            provider.unload()

    def test_startup_timeout_tears_down_started_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            server, model, mmproj = self.files(Path(temporary))
            process = FakeProcess()
            clock = AdvancingClock()
            with self.assertRaisesRegex(LlamaCppProviderError, "did not become ready"):
                LlamaCppProvider(
                    server,
                    model,
                    mmproj,
                    "llamacpp:heretic-2b-f16",
                    startup_timeout=0.3,
                    api_key="b" * 32,
                    http=FakeHttp(503),
                    popen_factory=lambda *_args, **_kwargs: process,
                    sleeper=lambda _: None,
                    monotonic=clock,
                )
            self.assertEqual(process.terminate_calls, 1)
            self.assertFalse(process.alive)

    def test_validation_rejects_nonliteral_loopback_before_process_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            server, model, mmproj = self.files(Path(temporary))
            launched = []
            with self.assertRaisesRegex(LlamaCppProviderError, "literal loopback"):
                LlamaCppProvider(
                    server,
                    model,
                    mmproj,
                    "llamacpp:heretic-8b-q8_0",
                    host="localhost",
                    api_key="c" * 32,
                    popen_factory=lambda *_args, **_kwargs: launched.append(True),
                )
            self.assertEqual(launched, [])


class GpuTelemetryTests(unittest.TestCase):
    def test_nvidia_smi_query_uses_argument_list_and_returns_numbers(self):
        captured = {}

        class Completed:
            returncode = 0
            stdout = "32607, 10000, 22607\n"

        def runner(command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
            return Completed()

        memory = query_gpu_memory(runner=runner, clock=lambda: 123.5)
        self.assertEqual((memory.total_mb, memory.used_mb, memory.free_mb), (32607, 10000, 22607))
        self.assertIsInstance(captured["command"], list)
        self.assertFalse(captured["kwargs"]["shell"])
        self.assertIn("--query-gpu=memory.total,memory.used,memory.free", captured["command"])

    def test_peak_observation_and_bounded_atomic_store_are_path_free(self):
        poller = PeakMemoryPoller(clock=lambda: 50.0)
        poller.observe(GpuMemory(32607, 4000, 28607, 1.0))
        poller.observe(GpuMemory(32607, 11800, 20807, 2.0))
        measurement = poller.measurement()
        self.assertEqual(measurement.peak_delta_mb, 7800)
        self.assertEqual(measurement.minimum_free_mb, 20807)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store_path = root / "measured-peaks.json"
            store = MeasuredPeakStore(store_path, max_entries=2)
            for index, model_id in enumerate(
                (
                    "llamacpp:heretic-2b-f16",
                    "llamacpp:heretic-4b-q8_0",
                    "llamacpp:heretic-8b-q8_0",
                ),
                start=1,
            ):
                store.record(
                    model_id,
                    PeakMeasurement(3, 32607, 4000, 4000 + index * 1000, index * 1000, 28000, float(index)),
                    context_length=6144 if "8b" in model_id else 8192,
                )
            snapshot = store.snapshot()
            self.assertEqual(len(snapshot), 2)
            self.assertNotIn("llamacpp:heretic-2b-f16", snapshot)
            raw = store_path.read_text(encoding="utf-8")
            self.assertNotIn(str(root), raw)
            self.assertNotIn("model_path", raw)
            self.assertEqual(
                store.get("llamacpp:heretic-8b-q8_0", context_length=6144)["context_length"],
                6144,
            )
            self.assertIsNone(store.get("llamacpp:heretic-8b-q8_0", context_length=8192))
            self.assertFalse(list(root.glob("*.tmp")))
            with self.assertRaisesRegex(GpuTelemetryError, "public model ID"):
                store.record(str(root / "private-model.gguf"), measurement)


if __name__ == "__main__":
    unittest.main()
