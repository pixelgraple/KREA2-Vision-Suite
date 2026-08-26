from __future__ import annotations

import errno
import hashlib
import io
import json
import re
import tempfile
import time
import unittest
from contextlib import contextmanager
from dataclasses import replace
from itertools import cycle, islice
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import app.api.analyze as api_module
from app.config import settings
from app.models.vision_provider import ModelReply
from app.services.discord_vision import (
    AGE_CLEAR,
    AGE_REJECT,
    COMPOSER_MODEL,
    COMPOSER_SCHEMA,
    COMPOSER_SYSTEM,
    APPEARANCE_SURFACE_CHECKLIST,
    BODY_WARDROBE_CHECKLIST,
    CAMERA_DETAIL_CHECKLIST,
    CRAFT_PASS,
    FACE_DETAIL_CHECKLIST,
    FINAL_DETAIL_CHECKLIST,
    HERETIC_AUDIT_SYSTEM,
    HERETIC_ANATOMY_VERIFY_SYSTEM,
    HERETIC_POSE_AUDIT_SYSTEM,
    HERETIC_COMPOSER_SYSTEM,
    HERETIC_CROP_FOCUS,
    HERETIC_CROP_PASS,
    HERETIC_POSE_PASS,
    HERETIC_SINGLE_COMPOSER_SYSTEM,
    HERETIC_SKIN_PASS,
    HERETIC_SUBJECT_PASS,
    KEEP_ALIVE,
    LEGACY_MODEL_ID,
    INTERACTION_TOPOLOGY_CHECKLIST,
    OFF_FRAME_EVIDENCE_RULE,
    PARTICIPANT_PRESENTATION_CHECKLIST,
    VISION_MODEL,
    PIPELINE_ID,
    POSE_GEOMETRY_CHECKLIST,
    POSE_SUPPORT_LEAN_CHECKLIST,
    SKIN_BODY_SURFACE_CHECKLIST,
    DatasetGuidanceReceipt,
    DiscordDescribeResponse,
    DiscordVisionBackendError,
    DiscordVisionCancelled,
    DiscordVisionDatasetUnavailable,
    DiscordVisionRejected,
    DiscordVisionSafetyRejected,
    DiscordVisionService,
    HereticWarmResidency,
    LocalOllamaDiscordClient,
    SUBJECT_PASS,
    _derive_grounding_requirements,
    _anatomy_consensus,
    _anatomy_status,
    _audited_draft_variants,
    _clean_final_prompt,
    _has_positive_visible_anatomy_evidence,
    _needs_anatomy_verification,
    _repair_grounding_locked_prompt,
    _validate_required_grounding,
    _words,
    dataset_guidance_receipt,
)
from app.services.forge_vram_handoff import ForgeHandoffError, ForgeVramHandoff
from app.services.discord_jobs import DiscordVisionJobStore
from app.services.discord_sessions import DiscordVisionSessionStore
from app.services.feedback_guidance import FEEDBACK_SCHEMA, parse_feedback_context
from app.services.krea2_dataset import Krea2Guidance, SAMPLE_SIZE
from app.services.model_catalog import ModelSpec
from app.services.shared_queue import QueueLease


TOKEN = "test-only-token-1234567890-abcdef"
STYLE_MARKER = "KREA2 STYLE/STRUCTURE GUIDANCE — TEST MARKER"


def applied_dataset_guidance() -> Krea2Guidance:
    sample_ids = tuple(f"k2_{index:024x}" for index in range(SAMPLE_SIZE))
    examples = "\n".join(
        f'<KREA2_STYLE_EXAMPLE index="{index + 1}" id="{sample_id}">example {index + 1}</KREA2_STYLE_EXAMPLE>'
        for index, sample_id in enumerate(sample_ids)
    )
    return Krea2Guidance(
        enabled=True,
        applied=True,
        status="ready",
        source="test",
        corpus_revision="a" * 64,
        sample_digest="b" * 64,
        sample_ids=sample_ids,
        corpus_size=12,
        sampled_count=SAMPLE_SIZE,
        cache_age_seconds=0,
        composer_guidance=f"{STYLE_MARKER}\n{examples}",
    )


class FakeDatasetSampler:
    def __init__(self, result: Krea2Guidance | None = None):
        self.result = result or applied_dataset_guidance()
        self.calls = []
        self.blocked_samples = []

    def build_guidance(self, *, enabled: bool, blocked_sample_digests=()):
        self.calls.append(enabled)
        self.blocked_samples.append(frozenset(blocked_sample_digests))
        return self.result


def prose(word_count: int, *, explicit: bool = False) -> str:
    vocabulary = (
        "the visible subject is in the image with detailed hair and clothing while the background "
        "light reveals material texture color expression pose action scene location and composition"
    ).split()
    words = list(islice(cycle(vocabulary), word_count))
    if explicit:
        words[-1] = "nudity"
    return " ".join(words) + "."


def variant_prose(index: int, word_count: int = 400, *, explicit: bool = False) -> str:
    common = "the visible subject and image are rendered with detailed pose clothing background light material texture color".split()
    accents = [
        "balanced literal framing expression hair anatomy wardrobe props location perspective focus shadows reflections atmosphere".split(),
        "gesture stance interaction limbs hands feet posture silhouette fabric accessories foreground relationship camera-relative geometry".split(),
        "environment architecture terrain composition illumination highlights surfaces depth palette contrast weather ambience spatial arrangement".split(),
    ][index]
    words = list(islice(cycle([*common, *accents]), word_count))
    if explicit:
        words[-1] = "nudity"
    return " ".join(words) + "."


def prompt_variants(first: str | None = None, *, explicit: bool = False) -> list[str]:
    return [
        first or variant_prose(0, explicit=explicit),
        variant_prose(1, explicit=explicit),
        variant_prose(2, explicit=explicit),
    ]


def image_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), "navy").save(buffer, "PNG")
    return buffer.getvalue()


class FakeQueue:
    def __init__(self, events):
        self.events = events
        self.entered = False

    @contextmanager
    def slot(self, status=None):
        self.entered = True
        self.events.append("queue-enter")
        if status:
            status("Shared Forge/Ollama GPU queue acquired")
        try:
            yield QueueLease("123_assistant.ticket", "n" * 43)
        finally:
            self.entered = False
            self.events.append("queue-exit")


class FakeHandoff:
    def __init__(self, queue, events):
        self.queue = queue
        self.events = events
        self.called = False

    def unload_forge_models(self, lease):
        assert self.queue.entered
        assert isinstance(lease, QueueLease)
        self.called = True
        self.events.append("forge-handoff")
        return {"unloaded": [], "offline": []}


class FakeOllama:
    def __init__(self, evidence, final_prompt):
        self.responses = iter(evidence)
        self.final_prompt = final_prompt
        self.evidence_calls = 0
        self.evidence_inputs = []
        self.compose_calls = 0
        self.compose_guidance = ""
        self.compose_dataset_guidance = None
        self.unloads = []

    def evidence(self, _encoded, _instruction, *, subject_pass=False):
        self.evidence_calls += 1
        self.evidence_inputs.append((_instruction, subject_pass))
        return next(self.responses)

    def compose(self, evidence, *, guidance="", dataset_guidance=None, feedback_context=None):
        self.compose_calls += 1
        self.composed_evidence = evidence
        self.compose_guidance = guidance
        self.compose_dataset_guidance = dataset_guidance
        self.compose_feedback_context = feedback_context
        return json.dumps({"prompt_variants": prompt_variants(self.final_prompt)})

    def unload(self, model):
        self.unloads.append(model)


class FakeHereticProvider:
    def __init__(self):
        self.evidence=iter([AGE_CLEAR+"\n"+prose(140),prose(130),prose(130),prose(130),prose(100),prose(100),prose(100)])
        self.image_calls=0
        self.text_calls=0
        self.image_prompts=[]
        self.image_output_budgets=[]
        self.text_prompts=[]
        self.text_output_budgets=[]

    def with_image_text(self,system,user,*_args):
        self.image_calls+=1
        self.image_prompts.append((system,user))
        self.image_output_budgets.append(_args[2] if len(_args) > 2 else None)
        if "one evidence-grounded KREA2 positive prompt" in system:
            return ModelReply(json.dumps({"prompt":prose(400)}))
        if "strict JSON" in system:
            return ModelReply(json.dumps({"prompt_variants":prompt_variants()}))
        if "reconstruction auditor" in system:
            return ModelReply(prose(80))
        if "pose-geometry verifier" in system or "literal pose-and-contact blueprint" in user:
            return ModelReply("The primary subject's posture is visually uncertain. "+prose(180))
        return ModelReply(next(self.evidence))

    def text(self,system,user,*_args):
        self.text_calls+=1
        self.text_prompts.append((system,user))
        self.text_output_budgets.append(_args[1] if len(_args) > 1 else None)
        if "prompt_variants" in system:
            return ModelReply(json.dumps({"prompt_variants":prompt_variants()}))
        return ModelReply(json.dumps({"prompt":prose(400)}))


class FakeHereticPipeline:
    def __init__(self):
        self.provider=FakeHereticProvider()
        self.events=[]
        self.slot_kwargs=[]
        self.spec=ModelSpec("llamacpp::heretic-8b-q8_0","Heretic — Qwen3-VL 8B Q8_0","llama_cpp","qwen3-vl-heretic-8b-q8-0",True,8192,2048,13312)
        self.telemetry=type("Telemetry",(),{"get":lambda _self,_model_id,**_kwargs:{}})()

    def _select_spec(self,model):
        self.events.append(("select",model))
        return self.spec

    def _active_settings(self,_spec):
        return replace(settings,queue_enabled=True)

    @contextmanager
    def _provider_slot(self,_active,_spec,progress,**kwargs):
        self.slot_kwargs.append(dict(kwargs))
        self.events.append("queue-enter")
        progress("Shared Forge/Ollama GPU queue acquired")
        progress("Verifying free VRAM for the selected local Vision model")
        supplier=kwargs.get("provider_supplier")
        provider=(supplier() if callable(supplier) else None) or self.provider
        retained=False
        try:
            yield provider,None,None,{}
        finally:
            retain=kwargs.get("retain_provider")
            if retain is not None:
                retained=bool(retain(provider,QueueLease("123_assistant.ticket","n" * 43)))
                if retained:
                    self.events.append("warm-retained-before-queue-release")
            if not retained:
                self.events.append("provider-unloaded-before-queue-release")
            self.events.append("queue-exit")


class FakeResponse:
    def __init__(self, payload=None, status=200):
        self.payload = payload or {}
        self.status = status

    def raise_for_status(self):
        if self.status >= 400:
            raise requests.HTTPError(f"HTTP {self.status}")

    def json(self):
        return self.payload


class RecordingHttp:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class StubDiscordService:
    def __init__(self):
        self.calls = 0
        self.path = None
        self.dataset_guidance = False
        self.reproducibility_guidance = None
        self.queue = type("QueueStatus", (), {"status": lambda _self: {"enabled": True, "count": 0, "entries": []}})()

    def describe(self, path, on_progress=None, model=None, guidance="", *, dataset_guidance=False, feedback_context=None):
        self.calls += 1
        self.path = Path(path)
        self.model = model
        self.guidance = guidance
        self.dataset_guidance = dataset_guidance
        self.feedback_context = feedback_context
        if not self.path.exists():
            raise AssertionError("prepared image was missing during inference")
        if on_progress:
            on_progress("queued", "Waiting for shared GPU queue", 1)
            on_progress("running", "Composing the final KREA2 prompt", 0)
        prompt = " ".join(["the"] * 400)
        return DiscordDescribeResponse(
            prompt=prompt,
            prompt_variants=prompt_variants(prompt),
            model="test-model",
            prompt_words=400,
            dataset_guidance=(
                dataset_guidance_receipt(applied_dataset_guidance(), feedback_context)
                if dataset_guidance
                else DatasetGuidanceReceipt(
                    enabled=False,
                    status="disabled",
                    corpus_digest=None,
                    sample_digest=None,
                    sample_count=0,
                )
            ),
        )

    def scheduler_status(self):
        return {
            "warm": {"active": False, "window_seconds": 15},
            "next_eligible_job": {"worker": "Discord KREA2 Vision", "eligible_now": True},
        }

    def reproducibility_for(self, model, dataset_guidance=None):
        self.reproducibility_guidance = dataset_guidance
        return {
            "schema_version": 1,
            "pipeline_id": PIPELINE_ID,
            "dataset_guidance": (
                dataset_guidance.model_dump()
                if isinstance(dataset_guidance, DatasetGuidanceReceipt)
                else dataset_guidance
            ),
            "model_id": model,
            "model_sha256": "a" * 64,
            "mmproj_sha256": "b" * 64,
        }


class StubKrea2Contributor:
    def __init__(self):
        self.calls = []
        self.error = None

    def submit(self, result):
        self.calls.append(result)
        if self.error is not None:
            raise self.error
        return type("Receipt", (), {
            "batch_sha256": "c" * 64,
            "dataset_revision": 1,
            "duplicate": False,
        })()


class StubKrea2DiagnosticReporter:
    def __init__(self):
        self.calls = []

    def submit_safely(self, **kwargs):
        self.calls.append(kwargs)
        return True


class WarmQueue:
    poll = 0.01

    def __init__(self):
        self.other_ticket = False

    def has_non_discord_ticket(self, *, exclude_ticket_name=None):
        return self.other_ticket


class WarmProvider:
    def __init__(self):
        self.unloaded = 0

    def unload(self):
        self.unloaded += 1


class WarmResidencyTests(unittest.TestCase):
    def test_matching_provider_is_reused_and_not_unloaded_until_eviction(self):
        queue=WarmQueue(); warm=HereticWarmResidency(queue,seconds=15)
        provider=WarmProvider(); lease=QueueLease("discord.ticket","n" * 43)
        self.assertTrue(warm.retain(provider,"llamacpp::heretic-8b-q8_0",lease))
        self.assertIs(warm.checkout("llamacpp::heretic-8b-q8_0"),provider)
        self.assertEqual(provider.unloaded,0)
        provider.unload()

    def test_non_discord_ticket_preempts_warm_provider_before_timeout(self):
        queue=WarmQueue(); warm=HereticWarmResidency(queue,seconds=15)
        provider=WarmProvider(); lease=QueueLease("discord.ticket","n" * 43)
        self.assertTrue(warm.retain(provider,"llamacpp::heretic-8b-q8_0",lease))
        queue.other_ticket=True
        deadline=time.monotonic()+1
        while provider.unloaded == 0 and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(provider.unloaded,1)
        self.assertFalse(warm.status()["active"])
        self.assertEqual(warm.status()["last_eviction_reason"],"preempted-by-shared-queue")


class DiscordVisionTests(unittest.TestCase):
    def build_service(self, ollama, dataset_sampler=None):
        events = []
        queue = FakeQueue(events)
        handoff = FakeHandoff(queue, events)
        service = DiscordVisionService(
            replace(settings, queue_enabled=True, model=LEGACY_MODEL_ID),
            queue=queue,
            handoff=handoff,
            ollama=ollama,
            dataset_sampler=dataset_sampler or FakeDatasetSampler(),
        )
        return service, queue, handoff, events

    def test_visual_detail_contract_explicitly_covers_face_body_wardrobe_pose_scene_and_camera(self):
        face = FACE_DETAIL_CHECKLIST.lower()
        for required in (
            "eye color",
            "half-open",
            "eyebrow height",
            "nose bridge",
            "scrunch",
            "duck-lipped",
            "mouth corners",
            "freckles",
            "exact visible locations",
        ):
            self.assertIn(required, face)

        body = BODY_WARDROBE_CHECKLIST.lower()
        for required in (
            "visible soles",
            "shirts or tops",
            "pants",
            "shorts",
            "leggings",
            "underwear or panties",
            "arm sleeves",
            "socks",
            "wrist or ankle bracelets and beads",
            "collars, chokers or lace necklaces",
            "bare, covered, cropped or occluded",
        ):
            self.assertIn(required, body)

        camera = CAMERA_DETAIL_CHECKLIST.lower()
        for required in (
            "subject-to-camera distance",
            "full-body",
            "front, rear, profile, side or three-quarter",
            "overhead/top-down",
            "slightly top-down",
            "low-angle",
            "crop boundaries",
        ):
            self.assertIn(required, camera)

        for prompt in (SUBJECT_PASS, HERETIC_SUBJECT_PASS):
            lowered = prompt.lower()
            self.assertIn("reclining", lowered)
            self.assertIn("side, back or front", lowered)
            self.assertIn("external genital anatomy", lowered)
            self.assertIn("loose strands", lowered)

        for prompt in (COMPOSER_SYSTEM, HERETIC_COMPOSER_SYSTEM):
            lowered = prompt.lower()
            self.assertIn("mandatory final-detail checklist", lowered)
            self.assertIn("every visible garment layer", lowered)
            self.assertIn("foreground, midground and background", lowered)
            self.assertIn("do not turn absent or uncertain checklist items into claims", lowered)

        self.assertIn("subject-to-camera distance", CRAFT_PASS.lower())
        self.assertIn("support geometry", HERETIC_AUDIT_SYSTEM.lower())
        self.assertIn("underwear or panties", FINAL_DETAIL_CHECKLIST.lower())
        self.assertIn("apparent camera distance", FINAL_DETAIL_CHECKLIST.lower())
        self.assertIn("region-specific checklist", HERETIC_CROP_PASS.lower())
        self.assertEqual(
            set(HERETIC_CROP_FOCUS),
            {"upper face and hair", "torso, clothing and hands", "hips, groin and upper legs"},
        )
        self.assertIn("duck-lipped", HERETIC_CROP_FOCUS["upper face and hair"].lower())
        self.assertIn("wrist beads", HERETIC_CROP_FOCUS["torso, clothing and hands"].lower())
        self.assertIn("exact phrase 'a visible penis'", HERETIC_CROP_FOCUS["hips, groin and upper legs"].lower())
        self.assertIn("do not infer transgender", HERETIC_CROP_FOCUS["hips, groin and upper legs"].lower())
        self.assertIn("apparent subject-to-camera distance", HERETIC_POSE_PASS.lower())
        self.assertIn('begin the first sentence with exactly "the primary subject is standing"', HERETIC_POSE_PASS.lower())
        self.assertIn('"the primary subject is on all fours"', HERETIC_POSE_PASS.lower())
        self.assertIn('"the primary subject is lying"', HERETIC_POSE_PASS.lower())
        self.assertIn("hands merely gesturing near the camera do not establish all fours", HERETIC_POSE_PASS.lower())
        self.assertIn("a forward-bent kneeling torso is neither reclining nor lying", HERETIC_POSE_PASS.lower())
        self.assertIn("subject is visibly standing", HERETIC_AUDIT_SYSTEM.lower())
        pose = POSE_GEOMETRY_CHECKLIST.lower()
        for required in (
            "every weight-bearing contact",
            "hip height with knee height",
            "left and right legs independently",
            "left and right arms independently",
            "torso pitch",
            "spinal arch or rounding",
            "abdominal compression or extension",
            "head and neck yaw, pitch and roll",
            "neither knee touching the floor",
            "missionary or rear-entry",
        ):
            self.assertIn(required, pose)
        self.assertIn("pose-geometry verifier", HERETIC_POSE_AUDIT_SYSTEM.lower())
        self.assertIn("a bright highlight alone is not proof", APPEARANCE_SURFACE_CHECKLIST.lower())
        self.assertIn("hair wetness or dryness", HERETIC_AUDIT_SYSTEM.lower())

        skin = SKIN_BODY_SURFACE_CHECKLIST.lower()
        for required in (
            "bruise or discoloration",
            "scratch, cut, abrasion",
            "friction or rope-pattern mark",
            "middle-aged-adult-presenting",
            "older-adult-presenting",
            "crow's-feet",
            "breast shape, hang",
            "abdominal softness",
            "pose-induced fold",
            "never diagnose disease",
        ):
            self.assertIn(required, skin)
        self.assertIn("skin, soft-tissue and visible-age-appearance map", HERETIC_SKIN_PASS.lower())
        self.assertIn("do not pad", HERETIC_SKIN_PASS.lower())
        self.assertIn("independently audit visible skin and soft tissue", HERETIC_AUDIT_SYSTEM.lower())

        lean = POSE_SUPPORT_LEAN_CHECKLIST.lower()
        for required in (
            "subject's left",
            "subject's right",
            "slight, moderate or deep",
            "weight-bearing, bracing, resting or merely touching",
            "braces against a wall",
            "support relationship uncertain",
        ):
            self.assertIn(required, lean)
        self.assertIn("anatomical-left or anatomical-right lean", HERETIC_POSE_AUDIT_SYSTEM.lower())
        self.assertIn("left lean changed to a right lean", HERETIC_AUDIT_SYSTEM.lower())

        off_frame = OFF_FRAME_EVIDENCE_RULE.lower()
        for required in (
            "crop boundary is an evidence boundary",
            "unknown, not absent",
            "decisive support geometry",
            "whole-body support state is outside the frame",
            "never complete hidden legs",
            "avoid long inventories",
        ):
            self.assertIn(required, off_frame)
        self.assertIn("uncertain sentence is mandatory", HERETIC_POSE_PASS.lower())
        self.assertIn("replace every categorical support-state claim", HERETIC_POSE_AUDIT_SYSTEM.lower())
        self.assertIn("every invented off-frame body part", HERETIC_AUDIT_SYSTEM.lower())

    def test_participants_keep_presentation_anatomy_and_interactions_separate(self):
        presentation = PARTICIPANT_PRESENTATION_CHECKLIST.lower()
        for required in (
            "subject a, subject b, subject c",
            "feminine-presenting",
            "masculine-presenting",
            "directly visible anatomy and identity as three separate facts",
            "feminine-presenting adult with a directly visible penis",
            "masculine-presenting adult with a directly visible vulva",
            "never infer transgender",
            "explicit uploader-supplied identity or role note",
        ):
            self.assertIn(required, presentation)

        interactions = INTERACTION_TOPOLOGY_CHECKLIST.lower()
        for required in (
            "actor, action, target",
            "exact contact body regions",
            "in front of or behind",
            "limbs, anatomy, clothing, gaze, poses and roles are never swapped",
            "never infer penetration",
        ):
            self.assertIn(required, interactions)

        for prompt in (
            SUBJECT_PASS,
            HERETIC_SUBJECT_PASS,
            POSE_GEOMETRY_CHECKLIST,
            FINAL_DETAIL_CHECKLIST,
            COMPOSER_SYSTEM,
            HERETIC_COMPOSER_SYSTEM,
            HERETIC_SINGLE_COMPOSER_SYSTEM,
            HERETIC_AUDIT_SYSTEM,
        ):
            lowered = prompt.lower()
            self.assertIn("subject a", lowered)
            self.assertIn("participant", lowered)

        self.assertIn("subject-to-anatomy association", HERETIC_AUDIT_SYSTEM.lower())
        self.assertIn("swapped participant", HERETIC_AUDIT_SYSTEM.lower())
        self.assertIn("uploader-supplied identity or role note", HERETIC_COMPOSER_SYSTEM.lower())

    def test_pose_and_visible_anatomy_become_machine_checked_non_negotiables(self):
        required = _derive_grounding_requirements(
            "The primary subject is standing upright on stone stairs, with both feet supporting her weight. " + prose(60),
            [
                "The displaced underwear sits around the thighs and a visible penis is centered at the bare groin. "
                + prose(60),
                "A separate close inspection also finds a visible penis at the groin. " + prose(60),
            ],
        )
        self.assertEqual(set(required), {"standing", "both_feet_weight_bearing", "visible_penis"})
        faithful = (
            "A single adult woman is standing upright on the stone stairs with both feet bearing weight, while a penis is visibly exposed at her groin. "
            + prose(400)
        )
        _validate_required_grounding(faithful, required)
        with self.assertRaisesRegex(DiscordVisionRejected, "standing"):
            _validate_required_grounding("A single adult woman sits on the stairs with a penis visible. " + prose(400), required)
        with self.assertRaisesRegex(DiscordVisionRejected, "penis"):
            _validate_required_grounding(
                "A single adult woman is standing upright on the stairs with both feet firmly planted and bearing her weight. "
                + prose(400),
                required,
            )

    def test_negative_or_uncertain_anatomy_evidence_does_not_create_a_fact(self):
        required = _derive_grounding_requirements(
            "The primary subject is standing upright. " + prose(60),
            ["No visible penis or vulva can be established because the groin is covered. " + prose(60)],
        )
        self.assertEqual(set(required), {"standing"})

    def test_one_freeform_anatomy_claim_cannot_become_a_hard_fact(self):
        required = _derive_grounding_requirements(
            "The primary subject is crouching with both feet supporting the body. " + prose(60),
            ["One pass incorrectly claims a visible penis at the groin. " + prose(60)],
        )
        self.assertNotIn("visible_penis", required)

    def test_independent_anatomy_sentinels_require_consensus(self):
        self.assertEqual(_anatomy_status("ANATOMY_STATUS: VISIBLE_VULVA\nDirect external folds are visible."), "VISIBLE_VULVA")
        self.assertEqual(_anatomy_consensus("VISIBLE_VULVA", "VISIBLE_VULVA"), "VISIBLE_VULVA")
        self.assertEqual(_anatomy_consensus("VISIBLE_PENIS", "VISIBLE_VULVA"), "NOT_ESTABLISHED")
        with self.assertRaisesRegex(DiscordVisionRejected, "status sentinel"):
            _anatomy_status("The image seems to show a penis.")
        self.assertIn("do not infer gender identity", HERETIC_ANATOMY_VERIFY_SYSTEM.lower())

    def test_positive_anatomy_candidate_ignores_negated_inventory(self):
        self.assertFalse(
            _has_positive_visible_anatomy_evidence(
                ["No visible penis or vulva can be established because the groin is covered."]
            )
        )
        self.assertTrue(
            _has_positive_visible_anatomy_evidence(
                ["The crop clearly contains a visible vulva at the exposed groin."]
            )
        )
        self.assertTrue(
            _needs_anatomy_verification(
                ["Her lower body is bare from the waist down and the exposed groin is centered in frame."]
            )
        )
        self.assertFalse(
            _needs_anatomy_verification(
                ["The groin is covered by opaque trousers and external anatomy is not visible."]
            )
        )

    def test_verified_vulva_removes_penis_drift_and_repeated_absence_spam(self):
        required = _derive_grounding_requirements("", [], anatomy_consensus="VISIBLE_VULVA")
        source = (
            "A clearly adult woman crouches in snow, with a penis visible at the groin, "
            "no visible jewelry, no visible jewelry, no visible tattoos, no visible tattoos, "
            + prose(390)
        )
        cleaned = _clean_final_prompt(source, required)
        self.assertNotIn("penis", cleaned.lower())
        self.assertEqual(cleaned.lower().count("no visible jewelry"), 1)
        self.assertEqual(cleaned.lower().count("no visible tattoos"), 1)
        repaired = _repair_grounding_locked_prompt(cleaned, required)
        self.assertIn("vulva", repaired.lower())
        self.assertNotIn("penis", repaired.lower())

    def test_final_prompt_caps_unique_no_visible_inventory(self):
        source = (
            "A clearly adult woman kneels on a bed, no visible jewelry, no visible tattoos, "
            "soft lighting creates no visible hard shadows, no visible scars, no visible bracelets, "
            "no visible necklaces, " + prose(390)
        )
        cleaned = _clean_final_prompt(source, {})
        self.assertLessEqual(cleaned.lower().count("no visible "), 2)
        self.assertIn("kneels", cleaned.lower())

    def test_unverified_anatomy_is_removed_instead_of_invented(self):
        required = _derive_grounding_requirements("", [], anatomy_consensus="NOT_ESTABLISHED")
        cleaned = _clean_final_prompt(
            "A clearly adult woman crouches in snow, a visible penis is centered at the groin, " + prose(390),
            required,
        )
        self.assertNotRegex(cleaned.lower(), r"\b(?:penis|vulva|vagina)\b")

    def test_feet_only_pose_cannot_be_validated_as_sitting_without_pelvic_support(self):
        invalid = (
            "The primary subject is sitting in a snowy forest, balanced entirely on the soles of both boots, "
            "with no other visible contact points. " + prose(80)
        )
        recovered = DiscordVisionService._heretic_pose_evidence(
            invalid.replace("no other visible contact points", "no other visible contact points; both knees are deeply flexed")
        )
        self.assertTrue(recovered.lower().startswith("the primary subject is crouching"))
        valid = (
            "The primary subject is sitting on a wooden bench with her buttocks visibly supported by the seat, "
            "while both feet rest on the floor. " + prose(80)
        )
        self.assertIn("sitting", DiscordVisionService._heretic_pose_evidence(valid).lower())

    def test_pose_pass_recovers_missing_sentinel_from_decisive_support_geometry(self):
        raw = (
            "A woman is balanced entirely on both boots with no other visible contact points. Both knees are "
            "deeply flexed, neither knee touches the snow, and her pelvis remains elevated without support. "
            + prose(90)
        )
        recovered = DiscordVisionService._heretic_pose_evidence(raw)
        self.assertTrue(recovered.lower().startswith("the primary subject is crouching"))

    def test_on_all_fours_is_distinct_and_cannot_drift_to_reclining(self):
        pose = (
            "The primary subject is on all fours on a bed. Both knees and shins visibly carry lower-body weight "
            "while both hands are planted on the bed and visibly bear upper-body weight; the pelvis is elevated "
            "and the torso leans deeply forward without resting on the mattress. " + prose(80)
        )
        recovered = DiscordVisionService._heretic_pose_evidence(pose)
        self.assertTrue(recovered.lower().startswith("the primary subject is on all fours"))
        required = _derive_grounding_requirements(recovered, [])
        self.assertIn("on_all_fours", required)
        faithful = "The primary subject is on all fours with both knees and both hands bearing weight on the bed. " + prose(390)
        _validate_required_grounding(faithful, required)
        with self.assertRaisesRegex(DiscordVisionRejected, "reclining"):
            _validate_required_grounding(faithful + " The primary subject is reclining on the bed.", required)
        cleaned = _clean_final_prompt(
            "The primary subject is on all fours on the bed. The primary subject is reclining on the bed. " + prose(390),
            required,
        )
        self.assertIn("on all fours", cleaned.lower())
        self.assertNotIn("reclining", cleaned.lower())

    def test_pose_state_requires_matching_support_and_rejects_gesture_contact_conflict(self):
        with self.assertRaisesRegex(DiscordVisionRejected, "sitting without visible pelvic support"):
            DiscordVisionService._heretic_pose_evidence(
                "The primary subject is sitting while balanced only on both feet. " + prose(80)
            )
        with self.assertRaisesRegex(DiscordVisionRejected, "reclining without visible torso support"):
            DiscordVisionService._heretic_pose_evidence(
                "The primary subject is reclining with only her raised pelvis and thighs touching the bed. " + prose(80)
            )
        resolved = DiscordVisionService._heretic_pose_evidence(
            "The primary subject is kneeling with both knees resting on the bed while her pelvis stays raised. "
            "Both hands are raised in V gestures, yet both hands are planted and weight-bearing on the bed. "
            + prose(80)
        )
        self.assertIn("raised in a visible gesture and are not weight-bearing", resolved.lower())
        self.assertNotIn("planted and weight-bearing", resolved.lower())
        required = _derive_grounding_requirements(resolved, [])
        self.assertIn("raised_hand_gesture", required)
        cleaned = _clean_final_prompt(
            "The primary subject is kneeling on the bed. Both hands are raised in V gestures, but both hands are "
            "planted and weight-bearing on the bed. " + prose(390),
            required,
        )
        self.assertNotIn("planted and weight-bearing", cleaned.lower())
        _validate_required_grounding(cleaned, required)
        valid = DiscordVisionService._heretic_pose_evidence(
            "The primary subject is kneeling with both knees and shins resting on the bed while her pelvis stays "
            "raised and both hands form V gestures without supporting her weight. " + prose(80)
        )
        self.assertTrue(valid.lower().startswith("the primary subject is kneeling"))

    def test_reclining_directly_on_couch_or_cushions_is_valid_torso_support(self):
        for surface in ("a couch", "the sofa cushions", "an upholstered seat"):
            recovered = DiscordVisionService._heretic_pose_evidence(
                f"The primary subject is reclining on {surface} with her torso angled back. " + prose(80)
            )
            self.assertIn("reclining", recovered.lower())

    def test_lying_is_distinct_from_reclining_and_squatting_from_crouching(self):
        lying = _derive_grounding_requirements(
            "The primary subject is lying on her side with the side of her torso broadly supported by the bed. " + prose(80),
            [],
        )
        self.assertIn("lying", lying)
        with self.assertRaisesRegex(DiscordVisionRejected, "reclining"):
            _validate_required_grounding(
                "The primary subject is reclining at an angle against the headboard. " + prose(390),
                lying,
            )
        squatting = _derive_grounding_requirements(
            "The primary subject is squatting on both feet with the pelvis unsupported. " + prose(80),
            [],
        )
        self.assertIn("squatting", squatting)
        self.assertNotIn("crouching", squatting)

    def test_deep_feet_supported_pose_locks_crouching_and_removes_seated_drift(self):
        pose = (
            "The primary subject's posture is visually uncertain. She is supported entirely by both feet planted "
            "flat in snow with no other visible contact points. Both knees are deeply flexed and remain clear of "
            "the snow while her hips stay above them. " + prose(80)
        )
        required = _derive_grounding_requirements(pose, [])
        self.assertIn("crouching", required)
        cleaned = _clean_final_prompt(
            "A single adult woman is crouching in snow, forming a wide seated posture, " + prose(390),
            required,
        )
        self.assertIn("crouching", cleaned.lower())
        self.assertNotIn("seated", cleaned.lower())

    def test_cropped_support_geometry_locks_posture_as_not_established(self):
        pose = (
            "The primary subject's posture is visually uncertain. The close crop ends at the upper torso, "
            "so the pelvis, knees, feet and support surface are outside the frame and the lower-body support "
            "state is not visually established. " + prose(80)
        )
        required = _derive_grounding_requirements(pose, [])
        self.assertIn("posture_not_established", required)

        cleaned = _clean_final_prompt(
            "The primary subject is reclining on a cushioned surface while both knees support her. "
            "The image is a tight close-up of her face and upper torso. " + prose(390),
            required,
        )
        self.assertNotRegex(cleaned.lower(), r"\b(?:reclining|knees support)\b")

        repaired = _repair_grounding_locked_prompt(cleaned, required)
        self.assertIn("primary subject's lower-body support state is not established", repaired.lower())
        _validate_required_grounding(repaired, required)
        with self.assertRaisesRegex(DiscordVisionRejected, "must not assert reclining"):
            _validate_required_grounding(
                repaired + " The primary subject is reclining on a bed.",
                required,
            )

    def test_standing_bent_forward_geometry_becomes_machine_checked_and_rejects_kneeling_drift(self):
        pose = (
            "The primary subject is standing on both feet on a straw-covered floor. "
            "Both feet are firmly planted and supporting her weight. Neither knee touches the floor. "
            "Her hips remain higher than her knees while her torso is bent forward at the waist. "
            "Her knees are only slightly flexed. Both hands rest on the fronts of her knees. "
            "Her head is turned back over her shoulder toward the camera. Her feet form a wide stance, "
            "with one foot farther back than the other. The camera is at floor-level in a low-angle view "
            "looking upward. Her full legs and both feet remain visible. " + prose(80)
        )
        required = _derive_grounding_requirements(pose, [])
        self.assertEqual(
            set(required),
            {
                "standing",
                "both_feet_weight_bearing",
                "knees_clear_surface",
                "hips_above_knees",
                "torso_forward_bend",
                "slight_knee_flexion",
                "hands_on_knees",
                "head_turned_back",
                "wide_stance",
                "one_foot_offset",
                "ground_level_low_angle",
                "full_legs_and_feet_visible",
            },
        )
        faithful = (
            "The primary subject is standing on both feet, with both feet firmly planted and supporting her weight. "
            "Neither knee touches the floor, and her hips remain higher than her knees as her torso is bent forward "
            "at the waist. Her knees are only slightly flexed. Both hands rest on the fronts of her knees while her "
            "head is turned back over her shoulder toward the camera. Her feet form a wide stance, with one foot "
            "farther back than the other. The camera is at floor-level in a low-angle view looking upward, and her "
            "full legs and both feet remain visible. " + prose(400)
        )
        _validate_required_grounding(faithful, required)
        with self.assertRaisesRegex(DiscordVisionRejected, "kneeling"):
            _validate_required_grounding(faithful + " The primary subject is kneeling on the floor.", required)
        with self.assertRaisesRegex(DiscordVisionRejected, "both hands"):
            _validate_required_grounding(faithful.replace("Both hands rest on the fronts of her knees", "Her arms remain visible"), required)

    def test_pillar_lean_and_distinctive_wardrobe_require_two_source_locks(self):
        initial_pose = (
            "The primary subject's posture is visually uncertain because the crop ends above the knees and feet. "
            "Her anatomical-right shoulder and upper back press into a white marble pillar. Her torso leans "
            "laterally toward her right while her hips shift left away from the pillar. " + prose(80)
        )
        verified_pose = (
            "The primary subject's posture is visually uncertain because the lower-body support state is outside "
            "the visible crop. Her right shoulder and upper back visibly brace against the white marble pillar. "
            "Her torso leans toward her right, and her pelvis shifts left away from the pillar as a counterbalance. "
            + prose(80)
        )
        details = [
            (
                "Her right hand lifts the front of a sheer pale blue lace top, exposing her bare midriff. "
                "The top has long lace sleeves. A low-rise sheer skirt sits low on her hips. " + prose(70)
            ),
            (
                "The fingers of her right hand hold and pull pale blue lace fabric at the front of a semi-transparent "
                "lace blouse, revealing the visible abdomen. Its long sheer sleeves reach the wrists, and a translucent "
                "skirt is low-rise and positioned low on the hips. " + prose(70)
            ),
        ]
        required = _derive_grounding_requirements(
            verified_pose,
            details,
            pose_confirmation=initial_pose,
        )
        for fact in (
            "external_support_contact",
            "lateral_torso_lean",
            "pelvis_countershift",
            "garment_held_or_lifted",
            "sheer_lace_top",
            "long_lace_sleeves",
            "exposed_midriff",
            "low_rise_sheer_skirt",
            "pale_blue_wardrobe",
        ):
            self.assertIn(fact, required)

        faithful = (
            "Her anatomical-right shoulder and upper back visibly brace against a white marble pillar, causing her "
            "torso to lean laterally toward her right while her pelvis shifts left away from the pillar. The cropped "
            "view does not establish her lower-body support state. Her right hand lifts and pulls the front of a "
            "sheer pale blue lace top, exposing her bare midriff; long lace sleeves reach her wrists, while a low-rise "
            "sheer skirt sits low on her hips. " + prose(400)
        )
        _validate_required_grounding(faithful, required)

        near_only = faithful.replace(
            "Her anatomical-right shoulder and upper back visibly brace against a white marble pillar, causing her ",
            "She is positioned close to a white marble pillar, and ",
        )
        with self.assertRaisesRegex(DiscordVisionRejected, "shoulder|external support"):
            _validate_required_grounding(near_only, required)

        late_contact = (
            "The cropped view does not establish her lower-body support state. "
            + prose(170)
            + " Her anatomical-right shoulder and upper back visibly brace against a white marble pillar, causing "
            "her torso to lean laterally toward her right while her pelvis shifts left away from the pillar. Her "
            "right hand lifts and pulls the front of a sheer pale blue lace top, exposing her bare midriff; long lace "
            "sleeves reach her wrists, while a low-rise sheer skirt sits low on her hips. "
            + prose(250)
        )
        with self.assertRaisesRegex(DiscordVisionRejected, "first 140 words"):
            _validate_required_grounding(late_contact, required)

    def test_external_support_lock_requires_pose_pass_and_independent_audit_agreement(self):
        verified_pose = (
            "The primary subject's posture is visually uncertain. Her right shoulder braces against a white pillar, "
            "and her torso leans laterally toward her right. " + prose(80)
        )
        unconfirmed_pose = (
            "The primary subject's posture is visually uncertain. The pillar is nearby, but visible contact is not "
            "established. " + prose(80)
        )
        required = _derive_grounding_requirements(
            verified_pose,
            [],
            pose_confirmation=unconfirmed_pose,
        )
        self.assertNotIn("external_support_contact", required)
        self.assertNotIn("lateral_torso_lean", required)

    def test_facing_camera_does_not_become_an_over_shoulder_turn(self):
        ordinary = (
            "The primary subject is crouching with both feet planted in snow. Her head is turned toward the camera "
            "and her gaze is direct. " + prose(80)
        )
        actual_turn = (
            "The primary subject is standing. Her head turns back over her shoulder toward the camera. " + prose(80)
        )
        self.assertNotIn("head_turned_back", _derive_grounding_requirements(ordinary, []))
        self.assertIn("head_turned_back", _derive_grounding_requirements(actual_turn, []))

    def test_single_heretic_prompt_recovers_token_capped_json_string_only(self):
        grounded = prose(500)
        truncated = '{"prompt":' + json.dumps(grounded)[:-1]
        recovered = DiscordVisionService._single_heretic_prompt(truncated)
        self.assertEqual(len(_words(recovered)), 500)
        with self.assertRaisesRegex(DiscordVisionRejected, "structured"):
            DiscordVisionService._single_heretic_prompt('{"analysis":"not a prompt"')

    def test_heretic_final_reorders_only_existing_sentences_when_model_repeats(self):
        words = prose(420).split()
        sentences = [" ".join(words[start:start + 70]).rstrip(".") + "." for start in range(0, 420, 70)]
        repeated = " ".join(sentences)
        result = DiscordVisionService._final_prompt(
            json.dumps({"prompt_variants": [repeated, repeated, repeated]}),
            True,
            "test model",
            enforce_age_gate=False,
            allow_plain_text=True,
        )
        self.assertEqual(len(set(result.prompt_variants)), 3)
        expected_sentences = sorted(sentences)
        for prompt in result.prompt_variants:
            actual = [item.strip() for item in re.split(r"(?<=[.!?])\s+", prompt) if item.strip()]
            self.assertEqual(sorted(actual), expected_sentences)
            self.assertEqual(len(_words(prompt)), 420)

    def test_three_evidence_passes_compose_bounded_prompt_and_unload_in_queue(self):
        ollama = FakeOllama(
            [
                AGE_CLEAR + "\n" + prose(140, explicit=True),
                prose(130),
                prose(130),
            ],
            prose(400, explicit=True),
        )
        sampler = FakeDatasetSampler()
        service, queue, handoff, events = self.build_service(ollama, sampler)
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "image.png"
            image.write_bytes(image_bytes())
            original_read = Path.read_bytes

            def guarded_read(path):
                self.assertTrue(queue.entered)
                self.assertTrue(handoff.called)
                events.append("image-read")
                return original_read(path)

            progress = []
            with patch("app.services.discord_vision.Path.read_bytes", new=guarded_read):
                result = service.describe(image, lambda *values: progress.append(values))

        self.assertEqual(result.classification, "usable")
        self.assertEqual(result.prompt_words, 400)
        self.assertEqual(len(result.prompt_variants), 3)
        self.assertEqual(result.prompt, result.prompt_variants[0])
        self.assertEqual(
            set(result.model_dump()),
            {
                "classification",
                "pipeline_id",
                "dataset_guidance",
                "prompt",
                "prompt_variants",
                "model",
                "prompt_words",
            },
        )
        self.assertEqual(result.pipeline_id, PIPELINE_ID)
        self.assertEqual(
            result.dataset_guidance.model_dump(),
            {
                "enabled": False,
                "status": "disabled",
                "corpus_digest": None,
                "sample_digest": None,
                "sample_count": 0,
                "feedback_digest": None,
                "liked_count": 0,
                "disliked_count": 0,
                "blocked_sample_count": 0,
            },
        )
        self.assertEqual(sampler.calls, [])
        self.assertEqual(ollama.evidence_calls, 3)
        self.assertEqual(ollama.compose_calls, 1)
        self.assertEqual(ollama.unloads, [VISION_MODEL, COMPOSER_MODEL])
        self.assertLess(events.index("forge-handoff"), events.index("image-read"))
        self.assertEqual(events[-1], "queue-exit")
        stages = [item[1] for item in progress]
        self.assertLess(stages.index("Releasing Forge VRAM for local Vision"), stages.index("Pass 1 of 3 — subject, expression, hair, pose and clothing"))
        self.assertLess(stages.index("Pass 1 of 3 — subject, expression, hair, pose and clothing"), stages.index("Pass 2 of 3 — scene, background, location and objects"))
        self.assertLess(stages.index("Pass 3 of 3 — composition, lighting, materials and color"), stages.index("Composing the final KREA2 prompt"))

    def test_dataset_guidance_applies_one_exact_eight_sample_only_to_legacy_composer(self):
        guidance = applied_dataset_guidance()
        sampler = FakeDatasetSampler(guidance)
        ollama = FakeOllama(
            [AGE_CLEAR + "\n" + prose(140), prose(130), prose(130)],
            prose(400),
        )
        service, _, _, _ = self.build_service(ollama, sampler)
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "image.png"
            image.write_bytes(image_bytes())
            result = service.describe(image, dataset_guidance=True)

        self.assertEqual(sampler.calls, [True])
        self.assertIs(ollama.compose_dataset_guidance, guidance)
        self.assertEqual(ollama.compose_dataset_guidance.sampled_count, SAMPLE_SIZE)
        self.assertNotIn(STYLE_MARKER, json.dumps(ollama.evidence_inputs))
        self.assertEqual(result.pipeline_id, PIPELINE_ID)
        self.assertEqual(result.dataset_guidance.sample_count, SAMPLE_SIZE)
        self.assertEqual(result.dataset_guidance.corpus_digest, "a" * 64)
        self.assertEqual(result.dataset_guidance.sample_digest, "b" * 64)
        self.assertEqual(len(result.prompt_variants), 3)

    def test_dataset_guidance_reuses_one_exact_sample_for_heretic_draft_and_repair_only(self):
        pipeline = FakeHereticPipeline()
        guidance = applied_dataset_guidance()
        sampler = FakeDatasetSampler(guidance)
        warm = Mock()
        warm.checkout.return_value = None
        warm.retain.return_value = True
        warm.status.return_value = {"active": True}
        service = DiscordVisionService(
            replace(settings, queue_enabled=True, model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]), []),
            ollama=FakeOllama([], prose(400)),
            pipeline=pipeline,
            warm=warm,
            dataset_sampler=sampler,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "image.png"
            image.write_bytes(image_bytes())
            result = service.describe(
                image,
                model="llamacpp::heretic-8b-q8_0",
                dataset_guidance=True,
            )

        composer_users = [
            user for system, user in pipeline.provider.text_prompts if "strict JSON" in system
        ]
        composer_budgets = [
            budget
            for (system, _user), budget in zip(
                pipeline.provider.text_prompts,
                pipeline.provider.text_output_budgets,
            )
            if "strict JSON" in system
        ]
        audit_budgets = [
            budget
            for (system, _user), budget in zip(
                pipeline.provider.image_prompts,
                pipeline.provider.image_output_budgets,
            )
            if "reconstruction auditor" in system
        ]
        non_composer_users = [user for _system, user in pipeline.provider.image_prompts]
        self.assertEqual(sampler.calls, [True])
        self.assertEqual(len(composer_users), 2)
        self.assertEqual(composer_budgets, [1024, 1536])
        self.assertEqual(audit_budgets, [768])
        self.assertEqual(sum(STYLE_MARKER in user for user in composer_users), 1)
        self.assertTrue(
            any("AUDITED DRAFT PROMPT" in user and STYLE_MARKER not in user for user in composer_users)
        )
        self.assertTrue(all("SKIN, SOFT-TISSUE AND VISIBLE-AGE-APPEARANCE" in user for user in composer_users))
        self.assertTrue(all(STYLE_MARKER not in user for user in non_composer_users))
        self.assertEqual(result.dataset_guidance.sample_count, SAMPLE_SIZE)
        self.assertEqual(result.dataset_guidance.sample_digest, guidance.sample_digest)
        self.assertEqual(len(result.prompt_variants), 3)

        reproducibility = service.reproducibility_for(
            "llamacpp::heretic-8b-q8_0", result.dataset_guidance
        )
        serialized = json.dumps(reproducibility)
        self.assertEqual(reproducibility["pipeline_id"], PIPELINE_ID)
        self.assertEqual(reproducibility["full_image_passes"], 5)
        self.assertEqual(
            reproducibility["dataset_guidance"], result.dataset_guidance.model_dump()
        )
        self.assertNotIn(STYLE_MARKER, serialized)
        self.assertNotIn("KREA2_STYLE_EXAMPLE", serialized)

    def test_local_feedback_guides_only_composition_and_blocks_downvoted_sample(self):
        liked_prompt = ("liked grounded structure with pose camera wardrobe texture lighting background and composition " * 15).strip()
        disliked_prompt = ("disliked generic structure with weak pose and camera details " * 20).strip()
        feedback = parse_feedback_context(
            json.dumps(
                {
                    "schema": FEEDBACK_SCHEMA,
                    "liked": [
                        {"id": hashlib.sha256(liked_prompt.encode()).hexdigest(), "prompt": liked_prompt}
                    ],
                    "disliked": [
                        {
                            "id": hashlib.sha256(disliked_prompt.encode()).hexdigest(),
                            "prompt": disliked_prompt,
                            "reason": "preserve the exact pose and angle",
                        }
                    ],
                    "blocked_sample_digests": ["f" * 64],
                }
            ),
            enabled=True,
        )
        sampler = FakeDatasetSampler(applied_dataset_guidance())
        ollama = FakeOllama(
            [AGE_CLEAR + "\n" + prose(140), prose(130), prose(130)],
            prose(400),
        )
        service, _, _, _ = self.build_service(ollama, sampler)
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "image.png"
            image.write_bytes(image_bytes())
            result = service.describe(
                image,
                dataset_guidance=True,
                feedback_context=feedback,
            )

        self.assertEqual(sampler.blocked_samples, [frozenset({"f" * 64})])
        self.assertIs(ollama.compose_feedback_context, feedback)
        self.assertNotIn("LOCAL PROMPT PREFERENCE", json.dumps(ollama.evidence_inputs))
        self.assertEqual(result.dataset_guidance.feedback_digest, feedback.digest)
        self.assertEqual(result.dataset_guidance.liked_count, 1)
        self.assertEqual(result.dataset_guidance.disliked_count, 1)
        self.assertEqual(result.dataset_guidance.blocked_sample_count, 1)

    def test_heretic_selection_runs_faithful_image_aware_pipeline_in_provider_slot(self):
        pipeline=FakeHereticPipeline()
        legacy_ollama=FakeOllama([],prose(400))
        warm=Mock()
        warm.checkout.return_value=None
        warm.retain.return_value=True
        warm.status.return_value={"active":True}
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=legacy_ollama,
            pipeline=pipeline,
            warm=warm,
        )
        progress=[]
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(image,on_progress=lambda *values: progress.append(values),model="llamacpp::heretic-8b-q8_0")
        self.assertEqual(result.prompt_words,400)
        self.assertIn("8B Q8_0",result.model)
        self.assertEqual(pipeline.provider.image_calls,10)
        self.assertEqual(pipeline.provider.text_calls,2)
        self.assertEqual(legacy_ollama.evidence_calls,0)
        self.assertEqual(legacy_ollama.compose_calls,0)
        crop_prompts = [
            user
            for _system, user in pipeline.provider.image_prompts
            if user.startswith(HERETIC_CROP_PASS)
        ]
        self.assertEqual(len(crop_prompts), 3)
        for region in HERETIC_CROP_FOCUS:
            self.assertTrue(any(f"CROP REGION: {region}." in prompt for prompt in crop_prompts))
        self.assertEqual(pipeline.events[-1:], ["queue-exit"])
        self.assertIsNone(pipeline.slot_kwargs[0]["queue_timeout_seconds"])
        self.assertIn(("running","Verifying free VRAM for the selected local Vision model",0),progress)
        self.assertLess(pipeline.events.index("warm-retained-before-queue-release"), pipeline.events.index("queue-exit"))
        self.assertTrue(service.warm.status()["active"])
        warm.evict()

    def test_legacy_local_vision_does_not_apply_gpu_wait_deadline(self):
        class TimeoutAwareQueue(FakeQueue):
            def __init__(self, events):
                super().__init__(events)
                self.received_timeout = "not-called"

            @contextmanager
            def slot(self, status=None, cancel_check=None, timeout_seconds=None):
                self.received_timeout = timeout_seconds
                if cancel_check is not None:
                    cancel_check()
                with super().slot(status=status) as lease:
                    if status is not None:
                        status("Forge handoff complete")
                    yield lease

        events=[]
        queue=TimeoutAwareQueue(events)
        handoff=FakeHandoff(queue,events)
        ollama=FakeOllama(
            [AGE_CLEAR + "\n" + prose(140), prose(130), prose(130)],
            prose(400),
        )
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID,gpu_availability_timeout_seconds=.05),
            queue=queue,
            handoff=handoff,
            ollama=ollama,
            dataset_sampler=FakeDatasetSampler(),
        )
        progress=[]
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"
            image.write_bytes(image_bytes())
            result=service.describe(image,on_progress=lambda *values: progress.append(values))

        self.assertEqual(result.classification,"usable")
        self.assertIsNone(queue.received_timeout)
        self.assertIn(("running","Forge handoff complete",0),progress)
        self.assertEqual(events[-1],"queue-exit")

    def test_remote_gemma_selection_skips_local_queue_warm_residency(self):
        pipeline=FakeHereticPipeline()
        legacy_ollama=FakeOllama([],prose(400))
        pipeline.spec=ModelSpec(
            "vast::gemma4-26b-a4b-heretic-q3_k_l",
            "Remote Serverless — Gemma 4 26B-A4B Heretic Q3_K_L (24 GB GPU)",
            "vast_serverless",
            "gemma4-26b-a4b-heretic-q3-k-l",
            False,
            8192,
            2048,
            18432,
        )
        warm=Mock()
        warm.status.return_value={"active":False}
        stages=[]
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=legacy_ollama,
            pipeline=pipeline,
            warm=warm,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(
                image,
                on_progress=lambda _status,stage,_ahead: stages.append(stage),
                model="vast::gemma4-26b-a4b-heretic-q3_k_l",
            )
        self.assertEqual(result.prompt_words,400)
        self.assertIn("26B-A4B",result.model)
        self.assertTrue(any("Waking remote GPU" in stage for stage in stages))
        warm.checkout.assert_not_called()
        warm.retain.assert_not_called()
        self.assertIn("provider-unloaded-before-queue-release",pipeline.events)
        self.assertEqual(legacy_ollama.evidence_calls,0)
        self.assertEqual(legacy_ollama.compose_calls,0)

    def test_cancelled_remote_bridge_failure_remains_cancelled_not_error(self):
        pipeline=FakeHereticPipeline()
        pipeline.spec=ModelSpec(
            "vast::gemma4-26b-a4b-heretic-q3_k_l",
            "Remote Serverless — Gemma 4 26B-A4B Heretic Q3_K_L (24 GB GPU)",
            "vast_serverless",
            "gemma4-26b-a4b-heretic-q3-k-l",
            False,
            8192,
            2048,
            18432,
        )
        pipeline.provider.with_image_text=Mock(side_effect=RuntimeError("cancelled bridge exited"))
        warm=Mock()
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=FakeOllama([],prose(400)),
            pipeline=pipeline,
            warm=warm,
        )
        cancellation_states=iter((False,False,True))
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            with self.assertRaises(DiscordVisionCancelled):
                service.describe(
                    image,
                    model="vast::gemma4-26b-a4b-heretic-q3_k_l",
                    is_cancelled=lambda: next(cancellation_states,True),
                )
        warm.evict.assert_called_with("job-cancelled")

    def test_heretic_faithful_pipeline_skips_sparse_detail_crops(self):
        pipeline=FakeHereticPipeline()
        original=pipeline.provider.with_image_text

        def sparse_crop(system,user,*args):
            if str(user).startswith("This is a close crop"):
                pipeline.provider.image_calls+=1
                return ModelReply("too short")
            return original(system,user,*args)

        pipeline.provider.with_image_text=sparse_crop
        stages=[]
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=FakeOllama([],prose(400)),
            pipeline=pipeline,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(image,on_progress=lambda _status,stage,_ahead: stages.append(stage),model="llamacpp::heretic-8b-q8_0")
        self.assertEqual(result.prompt_words,400)
        self.assertIn("faithful recreation",result.model)
        self.assertEqual(pipeline.provider.image_calls,13)
        self.assertTrue(any("no reliable extra evidence" in stage for stage in stages))

    def test_heretic_rechecks_malformed_first_pass_once_then_continues(self):
        pipeline=FakeHereticPipeline()
        pipeline.provider.evidence=iter([
            AGE_CLEAR+"\n"+prose(20),
            AGE_CLEAR+"\n"+prose(140),
            prose(130),
            prose(130),
            prose(180),
            prose(100),
            prose(100),
            prose(100),
        ])
        progress=[]
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=FakeOllama([],prose(400)),
            pipeline=pipeline,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(
                image,
                on_progress=lambda status,stage,ahead: progress.append(stage),
                model="llamacpp::heretic-8b-q8_0",
            )
        self.assertEqual(result.prompt_words,400)
        self.assertEqual(pipeline.provider.image_calls,11)
        self.assertTrue(any("independently rechecking" in stage for stage in progress))

    def test_heretic_builds_variants_separately_when_batched_json_fails_twice(self):
        pipeline=FakeHereticPipeline()
        original=pipeline.provider.text

        def sequential_fallback(system,user,*args):
            pipeline.provider.text_calls+=1
            pipeline.provider.text_prompts.append((system,user))
            pipeline.provider.text_output_budgets.append(args[1] if len(args) > 1 else None)
            if system == HERETIC_COMPOSER_SYSTEM:
                return ModelReply("batched output did not satisfy json")
            if "one evidence-grounded KREA2 positive prompt" in system:
                index=0 if "ROLE 1 OF 3" in user else 1 if "ROLE 2 OF 3" in user else 2
                return ModelReply(json.dumps({"prompt":variant_prose(index)}))
            return original(system,user,*args)

        pipeline.provider.text=sequential_fallback
        progress=[]
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=FakeOllama([],prose(400)),
            pipeline=pipeline,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(
                image,
                on_progress=lambda _status,stage,_ahead: progress.append(stage),
                model="llamacpp::heretic-8b-q8_0",
            )
        self.assertEqual(len(result.prompt_variants),3)
        self.assertEqual(result.prompt_words,400)
        self.assertTrue(any("variations separately" in stage for stage in progress))
        self.assertTrue(any("variation 3 of 3" in stage for stage in progress))

    def test_heretic_preserves_audited_draft_when_every_final_rewrite_is_malformed(self):
        pipeline=FakeHereticPipeline()
        draft_words=variant_prose(0,420).rstrip(".").split()
        draft=" ".join(
            " ".join(draft_words[index:index+60])+"."
            for index in range(0,len(draft_words),60)
        )

        def failed_final_rewrites(system,user,*args):
            pipeline.provider.text_calls+=1
            pipeline.provider.text_prompts.append((system,user))
            pipeline.provider.text_output_budgets.append(args[1] if len(args) > 1 else None)
            if system == HERETIC_SINGLE_COMPOSER_SYSTEM and "DRAFT ROLE" in user:
                return ModelReply(json.dumps({"prompt":draft}))
            if system == HERETIC_COMPOSER_SYSTEM:
                return ModelReply("the batch stopped after writing unusable transport")
            return ModelReply(json.dumps({"prompt":"too short"}))

        pipeline.provider.text=failed_final_rewrites
        progress=[]
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=FakeOllama([],prose(400)),
            pipeline=pipeline,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(
                image,
                on_progress=lambda _status,stage,_ahead: progress.append(stage),
                model="llamacpp::heretic-8b-q8_0",
            )

        self.assertEqual(len(result.prompt_variants),3)
        self.assertEqual(len(set(result.prompt_variants)),3)
        self.assertTrue(all(350 <= len(item.split()) <= 850 for item in result.prompt_variants))
        self.assertIn("faithful recreation",result.model)
        self.assertTrue(any("Preserving the audited image-grounded draft" in stage for stage in progress))

    def test_deterministic_grounding_repair_keeps_evidence_and_restores_locked_pose(self):
        base_words=variant_prose(0,420).rstrip(".").split()
        base=(
            "The primary subject is standing beside the visible surface. "
            + " ".join(base_words[:210])
            + ". "
            + " ".join(base_words[210:])
            + "."
        )
        required={"sitting":"the primary subject is explicitly sitting or seated"}
        repaired=_repair_grounding_locked_prompt(base,required)
        self.assertNotRegex(repaired.lower(),r"primary subject is standing")
        self.assertRegex(repaired.lower(),r"primary subject is explicitly sitting")
        variants=_audited_draft_variants(repaired,required)
        self.assertEqual(len(set(variants)),3)
        for prompt in variants:
            _validate_required_grounding(prompt,required)

    def test_heretic_ignores_legacy_age_reject_sentinel_and_describes_image(self):
        pipeline=FakeHereticPipeline()
        pipeline.provider.evidence=iter([
            AGE_REJECT+"\n"+prose(140),
            prose(130),
            prose(130),
            prose(180),
            prose(100),
            prose(100),
            prose(100),
        ])
        service=DiscordVisionService(
            replace(settings,queue_enabled=True,model=LEGACY_MODEL_ID),
            queue=FakeQueue([]),
            handoff=FakeHandoff(FakeQueue([]),[]),
            ollama=FakeOllama([],prose(400)),
            pipeline=pipeline,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image=Path(temporary)/"image.png"; image.write_bytes(image_bytes())
            result=service.describe(image,model="llamacpp::heretic-8b-q8_0")
        self.assertEqual(result.prompt_words,400)
        self.assertEqual(pipeline.provider.image_calls,10)
        self.assertEqual(pipeline.provider.text_calls,2)

    def test_uncertain_or_minor_age_status_stops_before_other_passes_and_composer(self):
        ollama = FakeOllama([AGE_REJECT + "\nAge presentation is uncertain."], prose(400))
        service, _, _, _ = self.build_service(ollama)
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "image.png"
            image.write_bytes(image_bytes())
            with self.assertRaisesRegex(DiscordVisionRejected, "clearly-adult"):
                service.describe(image)
        self.assertEqual(ollama.evidence_calls, 1)
        self.assertEqual(ollama.compose_calls, 0)
        self.assertEqual(ollama.unloads, [VISION_MODEL])

    def test_explicit_subject_evidence_without_clear_sentinel_is_rejected_before_composer(self):
        ollama = FakeOllama([prose(140, explicit=True)], prose(400, explicit=True))
        service, _, _, _ = self.build_service(ollama)
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "image.png"
            image.write_bytes(image_bytes())
            with self.assertRaisesRegex(DiscordVisionRejected, "sentinel"):
                service.describe(image)
        self.assertEqual(ollama.evidence_calls, 1)
        self.assertEqual(ollama.compose_calls, 0)

    def test_contradictory_age_sentinel_is_rejected_at_every_stage(self):
        expected_calls = {"subject": 1, "scene": 2, "craft": 3, "final": 3}
        for stage, calls in expected_calls.items():
            with self.subTest(stage=stage):
                evidence = [AGE_CLEAR + "\n" + prose(140), prose(130), prose(130)]
                final_prompt = prose(400)
                if stage == "subject":
                    evidence[0] += "\n" + AGE_REJECT
                elif stage == "scene":
                    evidence[1] += "\n" + AGE_REJECT
                elif stage == "craft":
                    evidence[2] += "\n" + AGE_REJECT
                else:
                    final_prompt += "\n" + AGE_REJECT
                ollama = FakeOllama(evidence, final_prompt)
                service, _, _, _ = self.build_service(ollama)
                with tempfile.TemporaryDirectory() as temporary:
                    image = Path(temporary) / "image.png"
                    image.write_bytes(image_bytes())
                    with self.assertRaisesRegex(DiscordVisionRejected, "age-safety"):
                        service.describe(image)
                self.assertEqual(ollama.evidence_calls, calls)
                self.assertEqual(ollama.compose_calls, 1 if stage == "final" else 0)
                self.assertEqual(ollama.unloads, [VISION_MODEL] if stage != "final" else [VISION_MODEL, COMPOSER_MODEL])

    def test_explicit_underage_evidence_is_rejected_at_every_stage(self):
        expected_calls = {"subject": 1, "scene": 2, "craft": 3, "final": 3}
        for stage, calls in expected_calls.items():
            with self.subTest(stage=stage):
                evidence = [AGE_CLEAR + "\n" + prose(140), prose(130), prose(130)]
                final_prompt = prose(400)
                unsafe = " The visible person is explicitly underage."
                if stage == "subject":
                    evidence[0] += unsafe
                elif stage == "scene":
                    evidence[1] += unsafe
                elif stage == "craft":
                    evidence[2] += unsafe
                else:
                    final_prompt += unsafe
                ollama = FakeOllama(evidence, final_prompt)
                service, _, _, _ = self.build_service(ollama)
                with tempfile.TemporaryDirectory() as temporary:
                    image = Path(temporary) / "image.png"
                    image.write_bytes(image_bytes())
                    with self.assertRaisesRegex(DiscordVisionRejected, "minor or underage"):
                        service.describe(image)
                self.assertEqual(ollama.evidence_calls, calls)
                self.assertEqual(ollama.compose_calls, 1 if stage == "final" else 0)

    def test_direct_minor_statement_is_rejected_even_with_clear_sentinel(self):
        with self.assertRaisesRegex(DiscordVisionRejected, "minor or underage"):
            DiscordVisionService._subject_evidence(
                AGE_CLEAR + "\n" + prose(120) + " The visible subject is a minor."
            )

    def test_explicit_final_prompt_requires_proven_clear_adult_flag(self):
        raw = json.dumps({"prompt_variants": prompt_variants(explicit=True)})
        with self.assertRaisesRegex(DiscordVisionRejected, "clearly-adult"):
            DiscordVisionService._final_prompt(raw, False)

    def test_numeric_age_and_structured_or_short_outputs_fail_closed(self):
        with self.assertRaisesRegex(DiscordVisionRejected, "numeric age"):
            DiscordVisionService._subject_evidence(AGE_CLEAR + "\n" + prose(120) + " age 25")
        with self.assertRaisesRegex(DiscordVisionRejected, "structured"):
            DiscordVisionService._final_prompt(
                json.dumps({"prompt_variants": [
                    "Subject: " + prose(200) + "\nScene: " + prose(200),
                    variant_prose(1),
                    variant_prose(2),
                ]}),
                True,
            )
        with self.assertRaisesRegex(DiscordVisionRejected, "detail bounds"):
            DiscordVisionService._final_prompt(
                json.dumps({"prompt_variants": [prose(40),variant_prose(1),variant_prose(2)]}),
                True,
            )

    def test_heretic_evidence_accepts_harmless_transport_and_json_wrappers(self):
        expected = prose(140)
        wrapped = (
            "<|channel|>thought<|channel|>final"
            "```json\n" + json.dumps({"description": expected}) + "\n```"
        )
        self.assertEqual(DiscordVisionService._heretic_evidence(wrapped), expected)
        self.assertEqual(
            DiscordVisionService._heretic_crop_evidence("Visual description: " + expected),
            expected,
        )

        with self.assertRaisesRegex(DiscordVisionRejected, "structured"):
            DiscordVisionService._heretic_evidence(
                json.dumps({"description": expected, "commentary": "not allowed"})
            )

    def test_variant_validation_accepts_reorganization_but_rejects_exact_duplicates(self):
        words=variant_prose(0).rstrip(".").split()
        reorganized=[
            " ".join(words)+".",
            " ".join(words[100:]+words[:100])+".",
            " ".join(words[200:]+words[:200])+".",
        ]
        accepted=DiscordVisionService._final_prompt(
            json.dumps({"prompt_variants":reorganized}),
            True,
        )
        self.assertEqual(len(accepted.prompt_variants),3)

        duplicate=list(reorganized)
        duplicate[1]=duplicate[0]
        with self.assertRaisesRegex(DiscordVisionRejected, "duplicate"):
            DiscordVisionService._final_prompt(
                json.dumps({"prompt_variants":duplicate}),
                True,
            )

    def test_final_prompt_accepts_detailed_variants_up_to_850_words(self):
        accepted = DiscordVisionService._final_prompt(
            json.dumps(
                {
                    "prompt_variants": [
                        variant_prose(index, 850) for index in range(3)
                    ]
                }
            ),
            True,
        )
        self.assertEqual(accepted.prompt_words, 850)
        self.assertTrue(
            all(len(item.split()) == 850 for item in accepted.prompt_variants)
        )

    def test_heretic_final_prompt_flattens_plain_section_labels(self):
        labeled = [
            "Subject: " + variant_prose(index, 200) + "\nScene: " + variant_prose(index, 200)
            for index in range(3)
        ]
        accepted = DiscordVisionService._final_prompt(
            json.dumps({"prompt_variants": labeled}),
            True,
            enforce_age_gate=False,
            allow_plain_text=True,
        )
        self.assertEqual(len(accepted.prompt_variants), 3)
        self.assertNotIn("Subject:", accepted.prompt)
        self.assertNotIn("Scene:", accepted.prompt)

    def test_final_prompts_remove_lora_and_all_other_angle_bracket_content(self):
        tagged = [
            variant_prose(index, 400)
            + " <lora:portrait-detail:0.85> <adapter:skin-texture>"
            for index in range(3)
        ]
        accepted = DiscordVisionService._final_prompt(
            json.dumps({"prompt_variants": tagged}),
            True,
            enforce_age_gate=False,
            allow_plain_text=True,
        )

        for prompt in accepted.prompt_variants:
            self.assertNotIn("<", prompt)
            self.assertNotIn(">", prompt)
            self.assertNotIn("lora:", prompt.casefold())
            self.assertNotIn("adapter:", prompt.casefold())

        single = DiscordVisionService._single_heretic_prompt(
            json.dumps({"prompt": tagged[0]})
        )
        self.assertNotIn("<", single)
        self.assertNotIn("lora:", single.casefold())

    def test_obscured_feature_wording_is_not_mistaken_for_a_refusal(self):
        grounded = (
            "The rear-facing crop is unable to show the subject's face, and the camera cannot see the eyes. "
            + prose(120)
        )
        accepted = DiscordVisionService._heretic_evidence(grounded)
        self.assertIn("unable to show", accepted)
        self.assertIn("cannot see", accepted)

        for refusal in (
            "I cannot help describe this image. " + prose(120),
            "I am unable to assist with this request. " + prose(120),
            "Sorry, but I cannot comply with this request. " + prose(120),
        ):
            with self.subTest(refusal=refusal.split(".", 1)[0]):
                with self.assertRaisesRegex(DiscordVisionRejected, "refused"):
                    DiscordVisionService._heretic_evidence(refusal)

    def test_heretic_intermediate_evidence_accepts_concise_grounded_prose(self):
        accepted = DiscordVisionService._heretic_evidence(prose(40))
        self.assertEqual(len(accepted.split()), 40)
        with self.assertRaisesRegex(DiscordVisionRejected, r"20 words; expected 40-450"):
            DiscordVisionService._heretic_evidence(prose(20))

    def test_heretic_intermediate_evidence_trims_overlong_grounded_prose(self):
        accepted = DiscordVisionService._heretic_evidence(prose(1663))
        self.assertGreaterEqual(len(accepted.split()), 40)
        self.assertLessEqual(len(accepted.split()), 450)
        scene = DiscordVisionService._heretic_evidence(prose(900), maximum_words=350)
        self.assertLessEqual(len(scene.split()), 350)
        crop = DiscordVisionService._heretic_crop_evidence(prose(500))
        self.assertLessEqual(len(crop.split()), 180)

    def test_ollama_contract_uses_natural_evidence_json_composer_and_explicit_unload(self):
        http = RecordingHttp([
            FakeResponse({"message": {"content": prose(120)}}),
            FakeResponse({"message": {"content": json.dumps({"prompt_variants": prompt_variants()})}}),
            FakeResponse({"done": True}),
        ])
        client = LocalOllamaDiscordClient("http://127.0.0.1:11434", http=http)
        client.evidence("base64-image", "inspect")
        client.compose(
            [prose(100), prose(100), prose(100)],
            dataset_guidance=applied_dataset_guidance(),
        )
        client.unload(COMPOSER_MODEL)
        evidence_payload = http.calls[0][1]["json"]
        composer_payload = http.calls[1][1]["json"]
        unload_payload = http.calls[2][1]["json"]
        self.assertNotIn("format", evidence_payload)
        self.assertIs(evidence_payload["think"], False)
        self.assertEqual(evidence_payload["keep_alive"], KEEP_ALIVE)
        self.assertEqual(composer_payload["format"], COMPOSER_SCHEMA)
        self.assertIs(composer_payload["think"], False)
        self.assertEqual(composer_payload["keep_alive"], KEEP_ALIVE)
        self.assertNotIn(STYLE_MARKER, json.dumps(evidence_payload))
        self.assertIn(STYLE_MARKER, composer_payload["messages"][1]["content"])
        self.assertEqual(
            composer_payload["messages"][1]["content"].count('<KREA2_STYLE_EXAMPLE index="'),
            SAMPLE_SIZE,
        )
        self.assertEqual(unload_payload["keep_alive"], 0)

    def test_forge_marks_only_verified_connection_refused_as_offline(self):
        class WindowsRefusedError(OSError):
            winerror = 10061

        refused_errors = [
            OSError(errno.ECONNREFUSED, "connection refused"),
            WindowsRefusedError("No connection could be made because the target machine refused it"),
        ]
        for socket_error in refused_errors:
            with self.subTest(
                errno=getattr(socket_error, "errno", None),
                winerror=getattr(socket_error, "winerror", None),
            ):
                offline = RecordingHttp([requests.ConnectionError(socket_error)])
                handoff = ForgeVramHandoff(
                    "http://127.0.0.1:7861",
                    handoff_token="t" * 48,
                    http=offline,
                )
                report = handoff.unload_forge_models(QueueLease("x.ticket", "n" * 43))
                self.assertEqual(report["offline"], ["http://127.0.0.1:7861"])

    def test_forge_reset_timeout_and_unverified_refusal_are_fatal(self):
        fatal_errors = [
            requests.ConnectionError("connection refused"),
            requests.ConnectionError(ConnectionResetError(errno.ECONNRESET, "connection reset")),
            requests.ConnectTimeout("connect timed out"),
            requests.ConnectTimeout(OSError(errno.ECONNREFUSED, "late wrapped refusal")),
            requests.ReadTimeout("read timed out"),
        ]
        for error in fatal_errors:
            with self.subTest(error=type(error).__name__, detail=str(error)):
                handoff = ForgeVramHandoff(
                    "http://127.0.0.1:7861",
                    handoff_token="t" * 48,
                    http=RecordingHttp([error]),
                )
                with self.assertRaises(ForgeHandoffError):
                    handoff.unload_forge_models(QueueLease("x.ticket", "n" * 43))

    def test_forge_reachable_http_error_is_fatal(self):
        reachable = RecordingHttp([FakeResponse(status=403)])
        handoff = ForgeVramHandoff(
            "http://127.0.0.1:7861",
            handoff_token="t" * 48,
            http=reachable,
        )
        with self.assertRaises(ForgeHandoffError):
            handoff.unload_forge_models(QueueLease("x.ticket", "n" * 43))


class DiscordVisionApiTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(api_module.router)
        self.service = StubDiscordService()
        self.contributor = StubKrea2Contributor()
        self.diagnostic_reporter = StubKrea2DiagnosticReporter()
        self.configured = replace(settings, discord_vision_token=TOKEN)
        self.temporary = tempfile.TemporaryDirectory()
        self.jobs = DiscordVisionJobStore(Path(self.temporary.name))
        self.sessions = DiscordVisionSessionStore()

    def tearDown(self):
        self.jobs.close()
        self.temporary.cleanup()

    def post(
        self,
        client,
        token=TOKEN,
        model="",
        guidance="",
        dataset_guidance=None,
        feedback_context=None,
        contribution_terms=api_module.CONTRIBUTION_TERMS_VERSION,
        diagnostic_terms=None,
        diagnostic_username=None,
    ):
        data = {"model": model, "guidance": guidance}
        if dataset_guidance is not None:
            data["dataset_guidance"] = dataset_guidance
        if feedback_context is not None:
            data["feedback_context"] = feedback_context
        if contribution_terms is not None:
            data["contribution_terms"] = contribution_terms
        if diagnostic_terms is not None:
            data["diagnostic_terms"] = diagnostic_terms
        if diagnostic_username is not None:
            data["diagnostic_username"] = diagnostic_username
        with patch.object(api_module, "discord_jobs", self.jobs), patch.object(
            api_module, "discord_sessions", self.sessions
        ), patch.object(
            api_module, "krea2_contributor", self.contributor
        ), patch.object(
            api_module, "krea2_diagnostic_reporter", self.diagnostic_reporter
        ):
            idempotency_key = hashlib.sha256(f"{time.time_ns()}:{model}".encode()).hexdigest()
            collector_version = "test-collector-1.0"
            session_headers = {
                "X-Krea2-Vision-Token": token,
                "X-Krea2-Collector-Version": collector_version,
            } if token is not None else {"X-Krea2-Collector-Version": collector_version}
            issued = client.post(
                "/api/discord-session",
                headers=session_headers,
                json={"idempotency_key": idempotency_key, "model": model or settings.model},
            )
            if not issued.is_success:
                return issued
            headers = {
                "X-Krea2-Vision-Session": issued.json()["session_token"],
                "X-Idempotency-Key": idempotency_key,
                "X-Krea2-Collector-Version": collector_version,
            }
            return client.post(
                "/api/discord-describe",
                headers=headers,
                data=data,
                files={"image": ("test.png", image_bytes(), "image/png")},
            )

    def test_route_requires_configured_secret_and_constant_time_header_match(self):
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", replace(settings, discord_vision_token="")
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            self.assertEqual(self.post(client).status_code, 503)

        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ), patch.object(api_module.hmac, "compare_digest", wraps=api_module.hmac.compare_digest) as compare:
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            self.assertEqual(self.post(client, "wrong-token").status_code, 401)
            compare.assert_called_once()
            self.assertIsInstance(compare.call_args.args[0], bytes)
            self.assertIsInstance(compare.call_args.args[1], bytes)

    def test_image_post_requires_request_bound_one_use_session(self):
        key = "a" * 64
        version = "test-collector-1.0"
        model = "llamacpp::heretic-8b-q8_0"
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "discord_jobs", self.jobs
        ), patch.object(
            api_module, "discord_sessions", self.sessions
        ), patch.object(
            api_module, "krea2_contributor", self.contributor
        ), patch.object(api_module, "settings", self.configured):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            issued = client.post(
                "/api/discord-session",
                headers={
                    "X-Krea2-Vision-Token": TOKEN,
                    "X-Krea2-Collector-Version": version,
                },
                json={"idempotency_key": key, "model": model},
            )
            self.assertEqual(issued.status_code, 200)
            self.assertEqual(issued.headers["cache-control"], "no-store")
            self.assertTrue(issued.json()["one_time"])
            token = issued.json()["session_token"]
            data = {
                "model": model,
                "contribution_terms": api_module.CONTRIBUTION_TERMS_VERSION,
            }
            mismatched = client.post(
                "/api/discord-describe",
                headers={
                    "X-Krea2-Vision-Session": token,
                    "X-Idempotency-Key": "b" * 64,
                    "X-Krea2-Collector-Version": version,
                },
                data=data,
                files={"image": ("test.png", image_bytes(), "image/png")},
            )
            replay_after_mismatch = client.post(
                "/api/discord-describe",
                headers={
                    "X-Krea2-Vision-Session": token,
                    "X-Idempotency-Key": key,
                    "X-Krea2-Collector-Version": version,
                },
                data=data,
                files={"image": ("test.png", image_bytes(), "image/png")},
            )
            self.assertEqual(mismatched.status_code, 401)
            self.assertEqual(replay_after_mismatch.status_code, 401)

            issued = client.post(
                "/api/discord-session",
                headers={
                    "X-Krea2-Vision-Token": TOKEN,
                    "X-Krea2-Collector-Version": version,
                },
                json={"idempotency_key": key, "model": model},
            )
            headers = {
                "X-Krea2-Vision-Session": issued.json()["session_token"],
                "X-Idempotency-Key": key,
                "X-Krea2-Collector-Version": version,
            }
            accepted = client.post(
                "/api/discord-describe",
                headers=headers,
                data=data,
                files={"image": ("test.png", image_bytes(), "image/png")},
            )
            replayed = client.post(
                "/api/discord-describe",
                headers=headers,
                data=data,
                files={"image": ("test.png", image_bytes(), "image/png")},
            )
            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(replayed.status_code, 401)

    def test_route_allows_contribution_opt_out_but_rejects_stale_opt_in_terms(self):
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            missing = self.post(client, contribution_terms=None)
            stale = self.post(client, contribution_terms="old-terms")
        self.assertEqual(missing.status_code, 200)
        self.assertEqual(stale.status_code, 428)
        self.assertEqual(self.service.calls, 1)
        self.assertEqual(self.contributor.calls, [])

    def test_failure_diagnostics_are_separate_opt_in_and_never_replace_public_error(self):
        class FailingService(StubDiscordService):
            def describe(self, *_args, **_kwargs):
                error = DiscordVisionRejected("private validator detail")
                error.diagnostic_prompt = "Audited partial prompt available for repair."
                raise error

        service = FailingService()
        with patch.object(api_module, "discord_vision", service), patch.object(
            api_module, "settings", self.configured
        ), patch.object(
            api_module, "start_background_task", side_effect=lambda function, **kwargs: function(**kwargs)
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            stale = self.post(client, contribution_terms=None, diagnostic_terms="old", diagnostic_username="tester")
            off = self.post(client, contribution_terms=None)
            enabled = self.post(
                client,
                contribution_terms=None,
                diagnostic_terms=api_module.DIAGNOSTIC_TERMS_VERSION,
                diagnostic_username="tester",
            )

        self.assertEqual(stale.status_code, 428)
        self.assertEqual(off.status_code, 502)
        self.assertEqual(enabled.status_code, 502)
        self.assertNotIn("private validator detail", enabled.text)
        self.assertEqual(len(self.diagnostic_reporter.calls), 1)
        report = self.diagnostic_reporter.calls[0]
        self.assertEqual(report["discord_username"], "tester")
        self.assertEqual(report["error_code"], "output_validation_failed")
        self.assertEqual(report["prompt_text"], "Audited partial prompt available for repair.")
        self.assertTrue(report["image_bytes"].startswith(b"\xff\xd8\xff"))

    def test_route_requires_literal_loopback_client(self):
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ):
            hostname = TestClient(self.app, client=("localhost", 50000), base_url="http://127.0.0.1:7870")
            remote = TestClient(self.app, client=("192.0.2.10", 50000), base_url="http://127.0.0.1:7870")
            hostile_host = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://attacker.example")
            self.assertEqual(self.post(hostname).status_code, 403)
            self.assertEqual(self.post(remote).status_code, 403)
            self.assertEqual(self.post(hostile_host).status_code, 403)

    def test_route_returns_only_bounded_contract_and_deletes_temporary_image(self):
        async def dispatch(function, *args, **kwargs):
            return function(*args, **kwargs)

        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ), patch.object(api_module, "run_in_threadpool", new=AsyncMock(side_effect=dispatch)) as threadpool:
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            response = self.post(client,model="llamacpp::heretic-8b-q8_0")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(response.json()),
            {
                "classification",
                "pipeline_id",
                "dataset_guidance",
                "prompt",
                "prompt_variants",
                "model",
                "prompt_words",
            },
        )
        self.assertEqual(response.json()["pipeline_id"], PIPELINE_ID)
        self.assertEqual(
            response.json()["dataset_guidance"],
            {
                "enabled": False,
                "status": "disabled",
                "corpus_digest": None,
                "sample_digest": None,
                "sample_count": 0,
                "feedback_digest": None,
                "liked_count": 0,
                "disliked_count": 0,
                "blocked_sample_count": 0,
            },
        )
        self.assertEqual(len(response.json()["prompt_variants"]),3)
        self.assertEqual(response.json()["classification"], "usable")
        self.assertEqual(self.service.calls, 1)
        self.assertEqual(self.service.model,"llamacpp::heretic-8b-q8_0")
        self.assertEqual(len(self.contributor.calls), 1)
        self.assertEqual(threadpool.await_count, 2)
        self.assertIs(threadpool.await_args_list[0].args[0].__self__, self.service)
        self.assertIs(threadpool.await_args_list[1].args[0].__self__, self.contributor)
        self.assertIsNotNone(self.service.path)
        self.assertFalse(self.service.path.exists())
        jobs = self.jobs.list()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], "completed")
        self.assertNotIn("prompt", jobs[0])
        self.assertEqual(self.jobs.get(jobs[0]["id"])["prompt_words"], 400)
        self.assertEqual(len(self.jobs.get(jobs[0]["id"])["prompt_variants"]),3)
        self.assertEqual(self.jobs.get(jobs[0]["id"])["reproducibility"]["model_sha256"], "a" * 64)
        self.assertEqual(
            self.jobs.get(jobs[0]["id"])["reproducibility"]["dataset_guidance"],
            response.json()["dataset_guidance"],
        )

    def test_online_contribution_failure_keeps_prompt_and_marks_job_completed(self):
        async def dispatch(function, *args, **kwargs):
            return function(*args, **kwargs)

        self.contributor.error = api_module.Krea2ContributionError("offline")
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ), patch.object(api_module, "run_in_threadpool", new=AsyncMock(side_effect=dispatch)):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            response = self.post(client)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["prompt_variants"]),3)
        jobs = self.jobs.list()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], "completed")
        self.assertEqual(jobs[0]["stage"], "Prompt ready")

    def test_dataset_guidance_form_is_strict_and_reproducibility_receives_safe_receipt(self):
        async def dispatch(function, *args, **kwargs):
            return function(*args, **kwargs)

        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ), patch.object(api_module, "run_in_threadpool", new=AsyncMock(side_effect=dispatch)):
            client = TestClient(
                self.app,
                client=("127.0.0.1", 50000),
                base_url="http://127.0.0.1:7870",
            )
            disabled = self.post(client, dataset_guidance="0")
            enabled = self.post(client, dataset_guidance="1")
            invalid = self.post(client, dataset_guidance="yes")

        self.assertEqual(disabled.status_code, 200)
        self.assertFalse(disabled.json()["dataset_guidance"]["enabled"])
        self.assertEqual(enabled.status_code, 200)
        self.assertTrue(enabled.json()["dataset_guidance"]["enabled"])
        self.assertEqual(enabled.json()["dataset_guidance"]["sample_count"], SAMPLE_SIZE)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.service.reproducibility_guidance.model_dump(), enabled.json()["dataset_guidance"])
        stored = next(
            detail["reproducibility"]
            for item in self.jobs.list()
            if (detail := self.jobs.get(item["id"]))
            and detail["reproducibility"].get("dataset_guidance", {}).get("enabled") is True
        )
        serialized = json.dumps(stored)
        self.assertEqual(stored["pipeline_id"], PIPELINE_ID)
        self.assertEqual(stored["dataset_guidance"], enabled.json()["dataset_guidance"])
        self.assertNotIn(STYLE_MARKER, serialized)
        self.assertNotIn("KREA2_STYLE_EXAMPLE", serialized)

    def test_dataset_guidance_unavailable_is_an_explicit_503(self):
        class UnavailableService(StubDiscordService):
            def describe(
                self,
                path,
                on_progress=None,
                model=None,
                guidance="",
                *,
                dataset_guidance=False,
                feedback_context=None,
            ):
                self.dataset_guidance = dataset_guidance
                raise DiscordVisionDatasetUnavailable("private dataset failure")

        service = UnavailableService()
        with patch.object(api_module, "discord_vision", service), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(
                self.app,
                client=("127.0.0.1", 50000),
                base_url="http://127.0.0.1:7870",
            )
            response = self.post(client, dataset_guidance="1")

        self.assertEqual(response.status_code, 503)
        self.assertTrue(service.dataset_guidance)
        self.assertNotIn("private dataset failure", response.text)
        job = self.jobs.list()[0]
        self.assertEqual(job["status"], "error")
        self.assertIn("dataset guidance", job["public_error"].lower())

    def test_feedback_context_requires_opt_in_and_reaches_only_the_local_service(self):
        prompt = ("liked local prompt with grounded subject pose camera clothing texture light and setting " * 14).strip()
        payload = json.dumps(
            {
                "schema": FEEDBACK_SCHEMA,
                "liked": [{"id": hashlib.sha256(prompt.encode()).hexdigest(), "prompt": prompt}],
                "disliked": [],
                "blocked_sample_digests": ["e" * 64],
            }
        )
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            rejected = self.post(client, dataset_guidance="0", feedback_context=payload)
            accepted = self.post(client, dataset_guidance="1", feedback_context=payload)

        self.assertEqual(rejected.status_code, 422)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["dataset_guidance"]["liked_count"], 1)
        self.assertEqual(accepted.json()["dataset_guidance"]["blocked_sample_count"], 1)
        self.assertEqual(self.service.feedback_context.liked_count, 1)
        self.assertNotIn(prompt, json.dumps(accepted.json()))

    def test_authenticated_cancel_and_clear_controls(self):
        job_id = self.jobs.create("c" * 64, "queued.png", job_id="1" * 32)
        with patch.object(api_module, "discord_jobs", self.jobs), patch.object(
            api_module, "discord_vision", self.service
        ), patch.object(api_module, "settings", self.configured):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            denied = client.post(f"/api/discord-jobs/{job_id}/cancel")
            accepted = client.post(
                f"/api/discord-jobs/{job_id}/cancel",
                headers={"X-Krea2-Vision-Token": TOKEN},
            )
            self.assertEqual(denied.status_code, 401)
            self.assertEqual(accepted.status_code, 200)
            self.assertTrue(accepted.json()["accepted"])
            self.assertTrue(self.jobs.is_cancel_requested(job_id))
            self.jobs.cancel(job_id)
            cleared = client.post(
                "/api/discord-jobs-clear-terminal",
                headers={"X-Krea2-Vision-Token": TOKEN},
            )
            self.assertEqual(cleared.status_code, 200)
            self.assertEqual(cleared.json()["cleared"], 1)

    def test_model_pair_install_routes_are_authenticated_and_forward_exact_id(self):
        manager = Mock()
        manager.start.return_value = {
            "model": "llamacpp::heretic-8b-q8_0",
            "state": "queued",
        }
        manager.status.return_value = {
            "model": "llamacpp::heretic-8b-q8_0",
            "state": "downloading",
            "progress_percent": 42.5,
        }
        with patch.object(api_module, "model_downloads", manager), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            denied = client.post(
                "/api/discord-models/install",
                json={"model": "llamacpp::heretic-8b-q8_0"},
            )
            started = client.post(
                "/api/discord-models/install",
                headers={"X-Krea2-Vision-Token": TOKEN},
                json={"model": "llamacpp::heretic-8b-q8_0"},
            )
            polled = client.get(
                "/api/discord-models/install/llamacpp%3A%3Aheretic-8b-q8_0",
                headers={"X-Krea2-Vision-Token": TOKEN},
            )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(started.status_code, 200)
        self.assertEqual(polled.status_code, 200)
        self.assertEqual(polled.headers["cache-control"], "no-store")
        manager.start.assert_called_once_with("llamacpp::heretic-8b-q8_0")
        manager.status.assert_called_once_with("llamacpp::heretic-8b-q8_0")

    def test_suite_update_routes_are_loopback_authenticated_and_no_store(self):
        manager = Mock()
        manager.accepting_new_jobs.return_value = True
        manager.check.return_value = {
            "state": "available",
            "current_version": "0.13.7",
            "latest_version": "0.13.8",
            "update_available": True,
        }
        manager.start.return_value = {
            "state": "queued",
            "current_version": "0.13.7",
            "latest_version": "0.13.8",
            "update_available": True,
        }
        manager.status.return_value = {"state": "downloading", "progress_percent": 42.0}
        with patch.object(api_module, "suite_updates", manager), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            denied = client.get("/api/suite-update")
            checked = client.get(
                "/api/suite-update",
                headers={"X-Krea2-Vision-Token": TOKEN},
            )
            started = client.post(
                "/api/suite-update/install",
                headers={"X-Krea2-Vision-Token": TOKEN},
            )
            polled = client.get(
                "/api/suite-update/status",
                headers={"X-Krea2-Vision-Token": TOKEN},
            )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(checked.status_code, 200)
        self.assertEqual(started.status_code, 200)
        self.assertEqual(polled.status_code, 200)
        self.assertEqual(checked.headers["cache-control"], "no-store")
        self.assertEqual(started.headers["cache-control"], "no-store")
        self.assertEqual(polled.headers["cache-control"], "no-store")
        manager.check.assert_called_once_with()
        manager.start.assert_called_once_with()
        manager.status.assert_called_once_with()

    def test_suite_update_maintenance_gate_blocks_new_image_sessions(self):
        manager = Mock()
        manager.accepting_new_jobs.return_value = False
        with patch.object(api_module, "suite_updates", manager), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            response = client.post(
                "/api/discord-session",
                headers={
                    "X-Krea2-Vision-Token": TOKEN,
                    "X-Krea2-Collector-Version": "0.13.7",
                },
                json={"idempotency_key": "a" * 64, "model": "llamacpp::heretic-8b-q8_0"},
            )
        self.assertEqual(response.status_code, 503)
        self.assertIn("waiting for Vision to become idle", response.json()["detail"])

    def test_bounded_workshop_guidance_reaches_only_the_local_service(self):
        with patch.object(api_module, "discord_vision", self.service), patch.object(
            api_module, "settings", self.configured
        ):
            client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            response = self.post(client, model="llamacpp::heretic-4b-q8_0", guidance="  Prioritize   clothing layers.  ")
            oversized = self.post(client, guidance="x" * 601)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.guidance, "Prioritize clothing layers.")
        self.assertEqual(oversized.status_code, 422)

    def test_dashboard_list_and_detail_are_loopback_only_and_prompt_is_not_polled(self):
        job_id = self.jobs.create("b" * 64, "test.png")
        prompt = " ".join(["visible"] * 400)
        self.jobs.complete(job_id, prompt=prompt, model="vision -> composer", prompt_words=400)
        with patch.object(api_module, "discord_jobs", self.jobs), patch.object(api_module, "discord_vision", self.service):
            local = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            remote = TestClient(self.app, client=("192.0.2.10", 50000), base_url="http://127.0.0.1:7870")
            hostile_host = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://attacker.example")
            listing = local.get("/api/discord-jobs?page=1&page_size=20&view=completed&q=test.png")
            detail = local.get(f"/api/discord-jobs/{job_id}")
            self.assertEqual(remote.get("/api/discord-jobs").status_code, 403)
            self.assertEqual(hostile_host.get("/api/discord-jobs").status_code, 403)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.headers["cache-control"], "no-store")
        self.assertNotIn("prompt", listing.json()["jobs"][0])
        self.assertEqual(listing.json()["pagination"]["total_items"], 1)
        self.assertEqual(listing.json()["pagination"]["page"], 1)
        self.assertEqual(detail.json()["prompt"], prompt)
        serialized = json.dumps(listing.json())
        self.assertNotIn("handoff_nonce", serialized)
        self.assertNotIn(TOKEN, serialized)

    def test_remote_worker_capacity_timeout_is_reported_as_gpu_not_available(self):
        cause = RuntimeError("Timed out after 1201.0s waiting for worker to become ready")
        error = DiscordVisionBackendError("The selected Heretic vision pipeline is unavailable.")
        error.__cause__ = cause

        stage, public_error, http_detail = api_module.backend_public_failure(
            error,
            "vast::gemma4-26b-a4b-heretic-q3_k_l",
        )

        self.assertEqual(stage, "GPU not available")
        self.assertEqual(public_error, "GPU not available")
        self.assertEqual(http_detail, "GPU not available")

    def test_nested_local_capacity_failure_is_actionable_instead_of_generic(self):
        cause = api_module.GpuCapacityError(
            "Local Vision needs at least 8192 MiB of free VRAM after Forge handoff, but only 7000 MiB is available."
        )
        error = DiscordVisionBackendError("The selected Heretic vision pipeline is unavailable.")
        error.__cause__ = cause

        stage, public_error, http_detail = api_module.backend_public_failure(
            error,
            "llamacpp::gemma4-12b-heretic-q8_0",
        )

        self.assertEqual(stage, "GPU not available")
        self.assertIn("needs at least 8192 MiB", public_error)
        self.assertEqual(http_detail, public_error)

    def test_nested_remote_transport_failure_is_actionable_instead_of_generic(self):
        cause = api_module.RemoteGatewayProviderError(
            "The remote Vision connection ended before a response was returned. It retried once; please retry the image."
        )
        error = DiscordVisionBackendError("The selected Heretic vision pipeline is unavailable.")
        error.__cause__ = cause

        stage, public_error, http_detail = api_module.backend_public_failure(
            error,
            "vast::gemma4-26b-a4b-heretic-q3_k_l",
        )

        self.assertEqual(stage, "Remote Vision failed")
        self.assertIn("connection ended before a response", public_error)
        self.assertNotIn("selected Heretic vision pipeline", public_error)
        self.assertEqual(http_detail, public_error)

    def test_rejected_and_backend_failures_store_safe_actionable_public_outcomes(self):
        class FailingService(StubDiscordService):
            def __init__(self, error):
                super().__init__()
                self.error = error

            def describe(self, path, on_progress=None, model=None, guidance="", *, dataset_guidance=False, feedback_context=None):
                if on_progress:
                    on_progress("running", "Pass 1 of 3", 0)
                raise self.error

        cases = [
            (DiscordVisionSafetyRejected("private unsafe detail"), 422, "rejected"),
            (DiscordVisionRejected("private malformed detail"), 502, "error"),
            (DiscordVisionBackendError("private backend detail"), 503, "error"),
        ]
        for error, expected_status, stored_status in cases:
            with self.subTest(stored_status=stored_status):
                isolated = DiscordVisionJobStore(Path(self.temporary.name) / stored_status)
                service = FailingService(error)
                with patch.object(api_module, "discord_jobs", isolated), patch.object(
                    api_module, "discord_vision", service
                ), patch.object(
                    api_module, "discord_sessions", self.sessions
                ), patch.object(api_module, "settings", self.configured):
                    client = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
                    idempotency_key = hashlib.sha256(f"failure:{time.time_ns()}".encode()).hexdigest()
                    collector_version = "test-collector-1.0"
                    issued = client.post(
                        "/api/discord-session",
                        headers={
                            "X-Krea2-Vision-Token": TOKEN,
                            "X-Krea2-Collector-Version": collector_version,
                        },
                        json={"idempotency_key": idempotency_key, "model": self.configured.model},
                    )
                    self.assertEqual(issued.status_code, 200)
                    response = client.post(
                        "/api/discord-describe",
                        headers={
                            "X-Krea2-Vision-Session": issued.json()["session_token"],
                            "X-Idempotency-Key": idempotency_key,
                            "X-Krea2-Collector-Version": collector_version,
                        },
                        data={"contribution_terms": api_module.CONTRIBUTION_TERMS_VERSION},
                        files={"image": ("test.png", image_bytes(), "image/png")},
                    )
                self.assertEqual(response.status_code, expected_status)
                job = isolated.list()[0]
                self.assertEqual(job["status"], stored_status)
                self.assertEqual(job["model"], self.configured.model)
                if isinstance(error, DiscordVisionBackendError):
                    self.assertIn("private backend detail", json.dumps(job).lower())
                else:
                    self.assertNotIn("private", json.dumps(job).lower())

    def test_mandatory_operational_error_route_is_loopback_authenticated_and_content_free(self):
        reporter = Mock()
        reporter.submit_safely.return_value = True
        with patch.object(api_module, "krea2_operational_error_reporter", reporter), patch.object(
            api_module, "settings", self.configured
        ):
            local = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            remote = TestClient(self.app, client=("192.0.2.10", 50000), base_url="http://127.0.0.1:7870")
            payload = {
                "event_id": "d" * 32,
                "model_id": "vast::gemma4-26b-a4b-heretic-q3_k_l",
                "error_code": "gpu_not_available",
                "error_message": "GPU not available",
                "stage": "Waiting to submit the Discord image",
            }
            denied = local.post("/api/discord-errors", json=payload)
            blocked = remote.post("/api/discord-errors", headers={"X-Krea2-Vision-Token": TOKEN}, json=payload)
            accepted = local.post(
                "/api/discord-errors",
                headers={"X-Krea2-Vision-Token": TOKEN, "X-Krea2-Collector-Version": "0.13.18"},
                json=payload,
            )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["accepted"], True)
        self.assertIn("no image", accepted.json()["privacy"].lower())
        kwargs = reporter.submit_safely.call_args.kwargs
        for forbidden in ("image_bytes", "prompt_text", "discord_username", "filename", "local_path"):
            self.assertNotIn(forbidden, kwargs)

    def test_mandatory_operational_error_route_retries_in_plugin_when_seedframe_is_unavailable(self):
        reporter = Mock()
        reporter.submit_safely.return_value = False
        with patch.object(api_module, "krea2_operational_error_reporter", reporter), patch.object(
            api_module, "settings", self.configured
        ):
            local = TestClient(self.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:7870")
            response = local.post(
                "/api/discord-errors",
                headers={"X-Krea2-Vision-Token": TOKEN, "X-Krea2-Collector-Version": "0.13.18"},
                json={
                    "event_id": "e" * 32,
                    "model_id": "llamacpp::heretic-4b-q8_0",
                    "error_code": "backend_unavailable",
                    "error_message": "Local backend is unavailable",
                    "stage": "Submitting the Vision image",
                },
            )
        self.assertEqual(response.status_code, 503)


if __name__ == "__main__":
    unittest.main()
