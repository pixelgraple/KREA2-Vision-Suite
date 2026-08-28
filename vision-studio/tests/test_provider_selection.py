from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, call, patch

from app.config import settings
from app.models import factory as factory_module
from app.models.factory import provider_for
from app.models.vision_provider import ModelReply
from app.schemas.prompt import PromptControls, PromptResult, StudioState
from app.schemas.visual_analysis import CriticReport, Evaluation, VisualAnalysis
from app.services.gpu_telemetry import GpuMemory, PeakMeasurement
from app.services.json_guard import instance_dict
from app.services.model_catalog import ModelSpec
from app.services.pipeline import GpuCapacityError, ProviderTeardownError, StudioPipeline
import app.services.pipeline as pipeline_module


def ollama_spec() -> ModelSpec:
    return ModelSpec(
        "ollama::qwen3-vl:30b",
        "Quality — Qwen3-VL 30B",
        "ollama",
        "qwen3-vl:30b",
        True,
        32768,
        8192,
        24576,
    )


def llama_spec(root: Path | None = None) -> ModelSpec:
    root = root or Path("C:/private-model-root")
    return ModelSpec(
        "llamacpp::heretic-8b-q8_0",
        "Heretic — Qwen3-VL 8B Q8_0",
        "llama_cpp",
        "qwen3-vl-heretic-8b-q8-0",
        True,
        8192,
        2048,
        13312,
        server_exe=root / "llama-server.exe",
        model_path=root / "body.gguf",
        mmproj_path=root / "mmproj.gguf",
    )


def gemma12_spec(root: Path | None = None) -> ModelSpec:
    root = root or Path("C:/private-model-root")
    return ModelSpec(
        "llamacpp::gemma4-12b-heretic-q8_0",
        "Heretic — Gemma 4 12B Q8_0",
        "llama_cpp",
        "gemma4-12b-heretic-q8-0",
        True,
        8192,
        2048,
        20992,
        server_exe=root / "llama-server.exe",
        model_path=root / "body.gguf",
        mmproj_path=root / "mmproj.gguf",
    )


class ProviderFactoryTests(unittest.TestCase):
    def test_ollama_uses_provider_tag_and_model_caps(self):
        configured = replace(settings, context_length=65536, max_output_tokens=12000)
        spec = ollama_spec()
        with patch.object(factory_module, "OllamaProvider", return_value="provider") as create:
            self.assertEqual(provider_for(configured, spec), "provider")
        create.assert_called_once_with(
            configured.api_base,
            "qwen3-vl:30b",
            32768,
            8192,
            configured.keep_alive,
        )

    def test_llama_cpp_uses_private_spec_paths_and_public_provider_alias_with_caps(self):
        with tempfile.TemporaryDirectory() as temporary:
            spec = llama_spec(Path(temporary))
            configured = replace(
                settings,
                context_length=32768,
                max_output_tokens=8192,
                llama_cpp_port=18091,
            )
            with patch.object(factory_module, "LlamaCppProvider", return_value="provider") as create:
                self.assertEqual(provider_for(configured, spec), "provider")
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["alias"], spec.provider_model)
        self.assertEqual(kwargs["host"], "127.0.0.1")
        self.assertEqual(kwargs["port"], 18091)
        self.assertEqual(kwargs["context"], 8192)
        self.assertEqual(kwargs["max_tokens"], 2048)
        self.assertEqual(kwargs["model_path"], spec.model_path)
        self.assertEqual(kwargs["mmproj_path"], spec.mmproj_path)

    def test_gemma12_uses_adaptive_fit_with_the_configured_safety_reserve(self):
        with tempfile.TemporaryDirectory() as temporary:
            spec = gemma12_spec(Path(temporary))
            configured = replace(settings, llama_cpp_vram_headroom_mb=4096)
            with patch.object(factory_module, "LlamaCppProvider", return_value="provider") as create:
                self.assertEqual(provider_for(configured, spec), "provider")
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["gpu_layers"], "auto")
        self.assertEqual(kwargs["fit_target_mb"], 4096)
        self.assertFalse(kwargs["mmproj_offload"])


class FakeQueue:
    def __init__(self, events):
        self.events = events

    @contextmanager
    def slot(self, _progress):
        self.events.append("queue-enter")
        try:
            yield object()
        finally:
            self.events.append("queue-exit")


class FakeHandoff:
    def __init__(self, events):
        self.events = events

    def unload_forge_models(self, _lease):
        self.events.append("forge-unload")
        return {"unloaded": ["loopback"]}

    def queued_forge_jobs(self):
        return []


class FakeOllamaHandoff:
    def __init__(self, events):
        self.events = events

    def unload_models(self, _lease):
        self.events.append("ollama-unload")
        return {"offline": False, "unloaded": ["resident:test"]}


class FakeProvider:
    def __init__(self, events):
        self.events = events
        self.unloads = 0

    def unload(self):
        self.unloads += 1
        self.events.append("provider-unload")


class FakePoller:
    def __init__(self, events):
        self.events = events

    def observe(self, _memory):
        self.events.append("telemetry-baseline")

    def start(self):
        self.events.append("telemetry-start")
        return self

    def stop(self):
        self.events.append("telemetry-stop")
        return PeakMeasurement(3, 32607, 3000, 9000, 6000, 23607, 10.0)


class FakeStore:
    def __init__(self, measured=0):
        self.measured = measured
        self.records = []

    def get(self, _model_id, **_kwargs):
        return {"peak_delta_mb": self.measured} if self.measured else None

    def record(self, model_id, measurement, **kwargs):
        self.records.append((model_id, measurement, kwargs.get("context_length")))


class PipelineSelectionTests(unittest.TestCase):
    def runner(self, **changes):
        overrides = {
            "queue_enabled": True,
            "llama_cpp_vram_headroom_mb": 4096,
        }
        overrides.update(changes)
        configured = replace(settings, **overrides)
        runner = StudioPipeline.__new__(StudioPipeline)
        runner.settings = configured
        runner.history = Mock()
        runner.telemetry = FakeStore()
        return runner

    def test_local_gpu_predicate_enables_same_queue_for_ollama_and_llama_cpp(self):
        runner = self.runner()
        for spec in (ollama_spec(), llama_spec()):
            active = runner._active_settings(spec)
            self.assertTrue(runner.queue(active, spec).enabled)
        remote = ModelSpec(
            "openai_compatible::configured",
            "Configured remote",
            "openai_compatible",
            "configured",
            False,
            8192,
            2048,
            0,
        )
        self.assertFalse(runner.queue(runner._active_settings(remote), remote).enabled)

    def test_handoff_capacity_provider_and_exact_teardown_are_ordered_inside_lease(self):
        events = []
        runner = self.runner()
        runner.telemetry = FakeStore(measured=7000)
        spec = llama_spec()
        active = runner._active_settings(spec)
        provider = FakeProvider(events)

        def create(*_args, **_kwargs):
            events.append("provider-create")
            return provider

        with (
            patch.object(runner, "queue", return_value=FakeQueue(events)),
            patch.object(pipeline_module, "ForgeVramHandoff", return_value=FakeHandoff(events)),
            patch.object(pipeline_module, "OllamaVramHandoff", return_value=FakeOllamaHandoff(events)),
            patch.object(
                pipeline_module,
                "query_gpu_memory",
                side_effect=lambda: GpuMemory(32607, 3000, 29607, 1.0),
            ),
            patch.object(
                pipeline_module,
                "PeakMemoryPoller",
                side_effect=lambda **_kwargs: FakePoller(events),
            ),
            patch.object(pipeline_module, "provider_for", side_effect=create) as provider_create,
        ):
            with runner._provider_slot(active, spec, lambda _message: None) as (_provider, _handoff, _before, capacity):
                events.append("body")
                self.assertEqual(capacity["required_vram_mb"], 17408)

        self.assertEqual(provider_create.call_count, 1)
        self.assertEqual(provider.unloads, 1)
        self.assertLess(events.index("queue-enter"), events.index("forge-unload"))
        self.assertLess(events.index("forge-unload"), events.index("ollama-unload"))
        self.assertLess(events.index("ollama-unload"), events.index("provider-create"))
        self.assertLess(events.index("provider-create"), events.index("body"))
        self.assertLess(events.index("body"), events.index("provider-unload"))
        self.assertLess(events.index("provider-unload"), events.index("queue-exit"))
        self.assertEqual(runner.telemetry.records[0][0], spec.public_id)
        self.assertEqual(runner.telemetry.records[0][2], active.context_length)

    def test_retained_provider_skips_second_unload_before_queue_release(self):
        events=[]
        runner=self.runner()
        spec=llama_spec()
        active=runner._active_settings(spec)
        provider=FakeProvider(events)
        with patch.object(runner,"queue",return_value=FakeQueue(events)):
            with runner._provider_slot(
                active,
                spec,
                lambda message: None,
                provider_supplier=lambda: provider,
                retain_provider=lambda _provider, _lease: events.append("retain") or True,
            ) as (_provider, _handoff, _before, capacity):
                events.append("body")
                self.assertEqual(capacity["check"],"reused warm Heretic provider")
        self.assertEqual(provider.unloads,0)
        self.assertLess(events.index("body"),events.index("retain"))
        self.assertLess(events.index("retain"),events.index("queue-exit"))

    def test_post_handoff_gate_uses_larger_of_estimate_and_measured_then_fails_closed(self):
        events = []
        runner = self.runner()
        runner.telemetry = FakeStore(measured=9000)
        spec = llama_spec()
        active = runner._active_settings(spec)
        with (
            patch.object(runner, "queue", return_value=FakeQueue(events)),
            patch.object(pipeline_module, "ForgeVramHandoff", return_value=FakeHandoff(events)),
            patch.object(pipeline_module, "OllamaVramHandoff", return_value=FakeOllamaHandoff(events)),
            patch.object(
                pipeline_module,
                "query_gpu_memory",
                return_value=GpuMemory(32607, 20607, 12000, 1.0),
            ),
            patch.object(pipeline_module, "provider_for") as create,
            patch.object(pipeline_module.time, "monotonic", side_effect=[0.0, 31.0]),
            patch.object(pipeline_module.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(GpuCapacityError, "17408 MiB"):
                with runner._provider_slot(active, spec, lambda _message: None):
                    pass
        create.assert_not_called()
        sleep.assert_not_called()
        self.assertEqual(events[:2], ["queue-enter", "forge-unload"])

    def test_post_handoff_capacity_waits_for_cuda_release_to_settle(self):
        runner = self.runner()
        runner.telemetry = FakeStore(measured=9000)
        spec = llama_spec()
        active = runner._active_settings(spec)
        readings = [
            GpuMemory(32607, 20607, 12000, 1.0),
            GpuMemory(32607, 3000, 29607, 2.0),
        ]
        with patch.object(pipeline_module, "query_gpu_memory", side_effect=readings), patch.object(
            pipeline_module.time, "sleep"
        ) as sleep:
            capacity, current = runner._capacity_for(active, spec)
        self.assertEqual(current.free_mb, 29607)
        self.assertEqual(capacity["free_vram_mb_after_handoff"], 29607)
        # Other background scheduler threads share Python's ``time`` module and
        # may make their own short sleeps while this mock is active. Verify the
        # handoff settle delay itself exactly once without coupling this test to
        # unrelated scheduler timing on slower hosted runners.
        self.assertEqual(sleep.call_args_list.count(call(0.5)), 1)

    def test_gemma12_adaptive_capacity_keeps_reserve_without_requiring_full_gpu_profile(self):
        runner = self.runner()
        runner.telemetry = FakeStore(measured=20543)
        spec = gemma12_spec()
        active = runner._active_settings(spec)
        with patch.object(
            pipeline_module,
            "query_gpu_memory",
            return_value=GpuMemory(32607, 8615, 23992, 1.0),
        ):
            capacity, current = runner._capacity_for(active, spec)
        self.assertEqual(current.free_mb, 23992)
        self.assertTrue(capacity["adaptive_gpu_fit"])
        self.assertEqual(capacity["runtime_fit_target_mb"], 4096)
        self.assertEqual(capacity["minimum_gpu_allocation_mb"], 4096)
        self.assertEqual(capacity["required_vram_mb"], 8192)
        self.assertEqual(capacity["full_gpu_required_vram_mb"], 25088)

    def test_gemma12_adaptive_capacity_still_fails_below_reserve_and_minimum_allocation(self):
        runner = self.runner()
        runner.telemetry = FakeStore(measured=20543)
        spec = gemma12_spec()
        active = runner._active_settings(spec)
        with (
            patch.object(
                pipeline_module,
                "query_gpu_memory",
                return_value=GpuMemory(32607, 24507, 8100, 1.0),
            ),
            patch.object(pipeline_module.time, "monotonic", side_effect=[0.0, 31.0]),
            patch.object(pipeline_module.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(GpuCapacityError, "at least 8192 MiB"):
                runner._capacity_for(active, spec)
        sleep.assert_not_called()

    def test_post_handoff_capacity_accepts_only_bounded_nvml_jitter(self):
        runner = self.runner()
        runner.telemetry = FakeStore(measured=9000)
        spec = llama_spec()
        active = runner._active_settings(spec)
        # Required is 17,408 MiB. A 15 MiB observation deficit still leaves
        # essentially the complete 4 GiB reserve and is accepted explicitly.
        with patch.object(
            pipeline_module,
            "query_gpu_memory",
            return_value=GpuMemory(32607, 15214, 17393, 1.0),
        ):
            capacity, current = runner._capacity_for(active, spec)
        self.assertEqual(current.free_mb, 17393)
        self.assertEqual(capacity["required_vram_mb"], 17408)
        self.assertEqual(capacity["admission_tolerance_mb"], 64)

    def test_post_handoff_capacity_rejects_beyond_nvml_jitter(self):
        runner = self.runner()
        runner.telemetry = FakeStore(measured=9000)
        spec = llama_spec()
        active = runner._active_settings(spec)
        with (
            patch.object(
                pipeline_module,
                "query_gpu_memory",
                return_value=GpuMemory(32607, 15264, 17343, 1.0),
            ),
            patch.object(pipeline_module.time, "monotonic", side_effect=[0.0, 31.0]),
            patch.object(pipeline_module.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(GpuCapacityError, "64 MiB measurement tolerance"):
                runner._capacity_for(active, spec)
        sleep.assert_not_called()

    def test_llama_cpp_refuses_to_bypass_disabled_shared_queue(self):
        runner = self.runner(queue_enabled=False)
        spec = llama_spec()
        active = runner._active_settings(spec)
        with (
            patch.object(runner, "queue") as queue,
            patch.object(pipeline_module, "provider_for") as create,
            patch.object(pipeline_module, "query_gpu_memory") as gpu_query,
        ):
            with self.assertRaisesRegex(GpuCapacityError, "requires the shared local-GPU queue"):
                with runner._provider_slot(active, spec, lambda _message: None):
                    pass
        queue.assert_not_called()
        create.assert_not_called()
        gpu_query.assert_not_called()

    def test_local_gpu_teardown_failure_is_critical_even_when_inference_failed(self):
        events = []
        runner = self.runner()
        runner.telemetry = FakeStore()
        spec = llama_spec()
        active = runner._active_settings(spec)

        class FailingUnloadProvider(FakeProvider):
            def unload(self):
                super().unload()
                raise RuntimeError("mock unload failure")

        provider = FailingUnloadProvider(events)
        with (
            patch.object(runner, "queue", return_value=FakeQueue(events)),
            patch.object(pipeline_module, "ForgeVramHandoff", return_value=FakeHandoff(events)),
            patch.object(pipeline_module, "OllamaVramHandoff", return_value=FakeOllamaHandoff(events)),
            patch.object(
                pipeline_module,
                "query_gpu_memory",
                return_value=GpuMemory(32607, 3000, 29607, 1.0),
            ),
            patch.object(
                pipeline_module,
                "PeakMemoryPoller",
                side_effect=lambda **_kwargs: FakePoller(events),
            ),
            patch.object(pipeline_module, "provider_for", return_value=provider),
        ):
            with self.assertRaisesRegex(ProviderTeardownError, "Critical local Vision cleanup") as raised:
                with runner._provider_slot(active, spec, lambda _message: None):
                    raise ValueError("mock inference failure")
        self.assertIsInstance(raised.exception.operation_error, ValueError)
        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertEqual(provider.unloads, 1)
        self.assertLess(events.index("provider-unload"), events.index("queue-exit"))

    def test_recompose_and_evaluate_preserve_selected_public_model_id(self):
        runner = self.runner(queue_enabled=False)
        spec = llama_spec()
        selected = []

        class ReplyProvider:
            def text(self, *_args):
                return ModelReply(json.dumps({"final_prompt": "rewritten", "negative_prompt": "", "sections": {}}))

            def with_image(self, *_args):
                payload=instance_dict(Evaluation)
                payload.update({"overall_reference_fidelity":91,"omissions":[]})
                return ModelReply(json.dumps(payload))

        provider = ReplyProvider()

        @contextmanager
        def slot(_active, selected_spec, _progress):
            selected.append(selected_spec.public_id)
            yield provider, None, {}, {"model_id": selected_spec.public_id}

        state = StudioState(
            pass1=VisualAnalysis(),
            critic=CriticReport(),
            merged=VisualAnalysis(environment={"description":"visible room"}),
            prompt=PromptResult(final_prompt="original"),
            debug={"model": spec.public_id},
        )
        with (
            patch.object(runner, "_select_spec", return_value=spec) as resolve,
            patch.object(runner, "_provider_slot", side_effect=slot),
        ):
            rewritten = runner.recompose(
                state,
                PromptControls(),
                "rewrite",
                model=spec.public_id,
            )
            score = runner.evaluate(Path("reference.jpg"), "prompt", model=spec.public_id)
        self.assertEqual(resolve.call_args_list[0].args[0], spec.public_id)
        self.assertEqual(resolve.call_args_list[1].args[0], spec.public_id)
        self.assertEqual(selected, [spec.public_id, spec.public_id])
        self.assertEqual(rewritten.debug["model"], spec.public_id)
        self.assertEqual(score.overall_reference_fidelity, 91)


if __name__ == "__main__":
    unittest.main()
