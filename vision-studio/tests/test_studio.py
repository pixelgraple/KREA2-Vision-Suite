from __future__ import annotations
import json, tempfile, threading, unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch
from PIL import Image
from app.models.vision_provider import ModelReply
from app.schemas.prompt import PromptControls, PromptResult
from app.schemas.visual_analysis import SubjectCensus, VisualAnalysis
from app.services.history import HistoryStore, PresetStore
from app.services.image_processor import ImageProcessor
from app.services.json_guard import instance_dict, parse_or_repair
from app.services.prompts import composer_user, merger_user
from app.services.shared_queue import QueueLease, SharedGenerationQueue
import app.services.shared_queue as shared_queue_module
from app.services.forge_vram_handoff import (
    HANDOFF_HEADER,
    HANDOFF_NONCE_HEADER,
    HANDOFF_PATH,
    HANDOFF_TICKET_HEADER,
    ForgeVramHandoff,
)
from app.services.model_catalog import ModelSpec, installed_qwen3_vl
from app.services.pipeline import StudioPipeline
from app.config import settings
import app.services.pipeline as pipeline_module

class RepairProvider:
    def text(self,*_):
        payload=instance_dict(VisualAnalysis)
        payload["subjects"]=[{"description":"one person","confidence":.9}]
        return ModelReply(json.dumps(payload))

class MockQwen:
    def __init__(self): self.images=0; self.texts=0
    def with_image(self,system,*_):
        self.images+=1
        if "strict visual census" in system: return ModelReply(json.dumps({"human_subject_count":2,"subjects":[{"index":1,"description":"first adult-presenting subject"},{"index":2,"description":"second adult-presenting subject"}],"uncertainty":""}))
        if "objective" in system:
            payload=instance_dict(VisualAnalysis)
            payload.update({"subject_count":1,"subjects":[{"description":"one adult-presenting subject","confidence":.9}],"primary_subject":{"hair":{"description":"dark wavy hair"},"pose":{"description":"standing"}}})
            return ModelReply(json.dumps(payload))
        return ModelReply(json.dumps({"confirmed_observations":["subject confirmed"],"corrections":[],"additions":["soft side light"],"removed_assumptions":[],"remaining_uncertainties":[]}))
    def text(self,system,user,*_):
        self.texts+=1
        if "non-negotiable count" in user: return ModelReply(json.dumps({"final_prompt":"portrait of two distinct adult subjects, separately described in the frame","negative_prompt":"text, watermark","sections":{"subject":"two distinct adult subjects"}}))
        if "corrected_visual_evidence" in user: return ModelReply(json.dumps({"final_prompt":"authentic portrait of a standing subject with dark wavy hair and soft side lighting","negative_prompt":"text, watermark","sections":{"hair":"dark wavy hair","pose":"standing"}}))
        payload=instance_dict(VisualAnalysis)
        payload.update({"subject_count":1,"subjects":[{"description":"one adult-presenting subject","confidence":.9}],"primary_subject":{"hair":{"description":"dark wavy hair"},"pose":{"description":"standing"}},"lighting":{"description":"soft side light"}})
        return ModelReply(json.dumps(payload))

class NonHumanQwen:
    def __init__(self): self.images=0; self.texts=0
    @staticmethod
    def analysis():
        payload=instance_dict(VisualAnalysis)
        payload.update({"subject_count":0,"environment":{"description":"black notification bar"},"composition":{"description":"wide horizontal crop"},"style_observations":["yellow warning icon and text"]})
        return payload
    def with_image(self,system,*_):
        self.images+=1
        if "strict visual census" in system:
            return ModelReply(json.dumps({"human_subject_count":0,"subjects":[],"uncertainty":""}))
        if "objective" in system:
            return ModelReply(json.dumps(self.analysis()))
        return ModelReply(json.dumps({"confirmed_observations":["notification bar"],"corrections":[],"additions":[],"removed_assumptions":[],"remaining_uncertainties":[]}))
    def text(self,_system,user,*_):
        self.texts+=1
        if "corrected_visual_evidence" in user:
            return ModelReply(json.dumps({"final_prompt":"a wide black notification bar with a yellow warning icon and yellow interface text","negative_prompt":"people, people, watermark","sections":{"environment":"black notification bar"}}))
        return ModelReply(json.dumps(self.analysis()))

class HallucinatingNonHumanQwen(NonHumanQwen):
    def text(self,_system,user,*_):
        self.texts+=1
        if "corrected_visual_evidence" in user:
            return ModelReply(json.dumps({"final_prompt":"a portrait of a woman in a room","negative_prompt":"watermark","sections":{"subject":"woman"}}))
        return ModelReply(json.dumps(self.analysis()))

class StudioTests(unittest.TestCase):
    @staticmethod
    def ollama_spec():
        return ModelSpec("ollama::qwen3-vl:30b","Quality — Qwen3-VL 30B","ollama","qwen3-vl:30b",True,32768,8192,24576)
    def test_malformed_model_json_is_repaired_not_silently_accepted(self):
        parsed=parse_or_repair(ModelReply("broken"),VisualAnalysis,RepairProvider(),.01)
        self.assertEqual(parsed.subjects[0]["description"],"one person")
    def test_schema_echo_is_repaired_to_an_instance_not_silently_accepted(self):
        parsed=parse_or_repair(ModelReply(json.dumps(VisualAnalysis.model_json_schema())),VisualAnalysis,RepairProvider(),.01)
        self.assertEqual(parsed.subjects[0]["description"],"one person")
    def test_repeated_schema_echo_fails_closed(self):
        provider=Mock(); provider.text.return_value=ModelReply(json.dumps(VisualAnalysis.model_json_schema()))
        with self.assertRaisesRegex(RuntimeError,"schema-only"):
            parse_or_repair(ModelReply(json.dumps(VisualAnalysis.model_json_schema())),VisualAnalysis,provider,.01)
    def test_truncated_negative_prompt_preserves_complete_positive_without_model_repair(self):
        provider=Mock()
        raw='{"final_prompt":"a black warning bar with a yellow icon","negative_prompt":"watermark, blur, repeated'
        parsed=parse_or_repair(ModelReply(raw),PromptResult,provider,.01)
        self.assertEqual(parsed.final_prompt,"a black warning bar with a yellow icon")
        self.assertEqual(parsed.negative_prompt,"watermark, blur, repeated")
        self.assertEqual(parsed.sections,{})
        provider.text.assert_not_called()
    def test_image_processor_validates_format_and_resizes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/"source.png"; Image.new("RGB",(3000,1000),"purple").save(source)
            output,digest=ImageProcessor(5_000_000,5_000_000,1200).prepare(source,root)
            with Image.open(output) as image: self.assertLessEqual(max(image.size),1200); self.assertEqual(image.format,"JPEG")
            self.assertEqual(len(digest),64)
    def test_image_processor_upscales_small_detail_crops_for_vision(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/"source.png"; Image.new("RGB",(480,640),"purple").save(source)
            crops=ImageProcessor(5_000_000,5_000_000,1200).crops(source,root)
            self.assertEqual(len(crops),3)
            for _,path in crops:
                with Image.open(path) as image: self.assertGreaterEqual(max(image.size),1000)
    def test_locks_are_given_to_merger_and_composer(self):
        analysis=VisualAnalysis(primary_subject={"face":{"shape":"oval"}}); controls=PromptControls(locks={"face":True,"outfit":True})
        merged=merger_user(SubjectCensus(human_subject_count=1),analysis,__import__('app.schemas.visual_analysis',fromlist=['CriticReport']).CriticReport(),[],analysis,controls.locks)
        prompt=composer_user(analysis,controls,PromptResult(final_prompt="old prompt"))
        self.assertIn('primary_subject.face',merged); self.assertIn('primary_subject.wardrobe',merged); self.assertIn('"face", "clothing"',prompt)
        self.assertNotIn('"properties"',prompt); self.assertNotIn('"output_schema"',prompt)
        self.assertIn("never invent people",prompt)
    def test_preset_store_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); store=PresetStore(root); values=store.save("Raw Webcam",{"mode":"Webcam"})
            self.assertEqual(values[0]["controls"]["mode"],"Webcam")
            self.assertEqual(list(root.iterdir()),[])
            self.assertEqual(PresetStore(root).list(),[])
    def test_history_store_is_session_only_and_never_creates_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); store=HistoryStore(root)
            prompt=PromptResult(final_prompt="grounded prompt",negative_prompt="watermark")
            store.add("a"*64,prompt,{"mode":"photo"},"model","notes")
            self.assertEqual(store.list()[0]["prompt"],"grounded prompt")
            self.assertEqual(list(root.iterdir()),[])
            self.assertEqual(HistoryStore(root).list(),[])
    def test_shared_queue_prevents_parallel_gpu_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            one,two=SharedGenerationQueue("one",directory=directory,poll=.02),SharedGenerationQueue("two",directory=directory,poll=.02)
            entered,release,second=threading.Event(),threading.Event(),threading.Event()
            a=threading.Thread(target=lambda: self._hold(one,entered,release)); b=threading.Thread(target=lambda: self._enter(two,second)); a.start(); self.assertTrue(entered.wait(1)); b.start(); self.assertFalse(second.wait(.15)); release.set(); self.assertTrue(second.wait(1)); a.join(1);b.join(1);self.assertFalse(list(Path(directory).glob("*.ticket")))
    def test_shared_queue_lease_matches_nonce_written_into_ticket(self):
        with tempfile.TemporaryDirectory() as directory:
            queue=SharedGenerationQueue("babegen-prompt-assistant-test",directory=directory)
            with queue.slot() as lease:
                self.assertIsInstance(lease,QueueLease)
                payload=json.loads((Path(directory)/lease.ticket_name).read_text(encoding="utf-8"))
                self.assertEqual(payload["handoff_nonce"],lease.nonce)
                self.assertGreaterEqual(len(lease.nonce),32)
    def test_shared_queue_keeps_unknown_process_ticket_and_removes_dead_ticket(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); queue=SharedGenerationQueue("test",directory=directory)
            ticket=root/"1_424242_1_x_forge.ticket"
            ticket.write_text("{}",encoding="utf-8")
            with patch.object(shared_queue_module,"alive",return_value=None): queue._clean(root/"own.ticket")
            self.assertTrue(ticket.exists())
            with patch.object(shared_queue_module,"alive",return_value=False): queue._clean(root/"own.ticket")
            self.assertFalse(ticket.exists())
    def test_windows_process_lookup_distinguishes_dead_from_indeterminate(self):
        kernel32=Mock(); kernel32.OpenProcess.return_value=0
        with patch.object(shared_queue_module.os,"name","nt"), patch.object(shared_queue_module.ctypes,"windll",create=True) as windll:
            windll.kernel32=kernel32
            kernel32.GetLastError.return_value=5
            self.assertIsNone(shared_queue_module.alive(424242))
            kernel32.GetLastError.return_value=87
            self.assertFalse(shared_queue_module.alive(424242))
    def test_mock_qwen_executes_all_four_prompt_pipeline_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/"reference.jpg"; Image.new("RGB",(640,640),"navy").save(source)
            mock=MockQwen(); old=pipeline_module.provider_for; pipeline_module.provider_for=lambda *_args,**_kwargs:mock
            try:
                stored_models=[]
                runner=StudioPipeline(replace(settings,queue_enabled=False)); runner.history=type("NoHistory",(),{"add":lambda _self,_hash,_prompt,_controls,model,_notes:stored_models.append(model)})()
                with patch.object(pipeline_module,"resolve_model",return_value=self.ollama_spec()):
                    result=runner.analyze(source,"a"*64,PromptControls(deep_inspection=False))
            finally: pipeline_module.provider_for=old
            self.assertEqual(mock.images,4); self.assertEqual(mock.texts,3); self.assertIn("two distinct",result.prompt.final_prompt); self.assertEqual(result.debug["stages"],["subject_census","pass1","pass2","merge","subject_count_repair","composer","subject_count_prompt_repair"])
            self.assertEqual(result.debug["model"],"ollama::qwen3-vl:30b"); self.assertEqual(stored_models,["ollama::qwen3-vl:30b"])
    def test_non_human_image_skips_person_biased_crops_and_deduplicates_negative(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/"notification.jpg"; Image.new("RGB",(640,120),"black").save(source)
            mock=NonHumanQwen(); runner=StudioPipeline(replace(settings,queue_enabled=False)); runner.history=Mock()
            with patch.object(pipeline_module,"provider_for",return_value=mock), patch.object(pipeline_module,"resolve_model",return_value=self.ollama_spec()):
                result=runner.analyze(source,"b"*64,PromptControls(deep_inspection=True))
            self.assertEqual(mock.images,3)
            self.assertNotIn("deep_inspection",result.debug["stages"])
            self.assertIn("No human subjects",result.debug["deep_inspection_skipped"])
            self.assertEqual(result.prompt.negative_prompt,"people, watermark")
    def test_zero_person_composer_hallucination_falls_back_to_grounded_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/"notification.jpg"; Image.new("RGB",(640,120),"black").save(source)
            mock=HallucinatingNonHumanQwen(); runner=StudioPipeline(replace(settings,queue_enabled=False)); runner.history=Mock()
            with patch.object(pipeline_module,"provider_for",return_value=mock), patch.object(pipeline_module,"resolve_model",return_value=self.ollama_spec()):
                result=runner.analyze(source,"c"*64,PromptControls(deep_inspection=True))
            self.assertIn("grounded_composer_fallback",result.debug["stages"])
            self.assertIn("black notification bar",result.prompt.final_prompt)
            self.assertNotRegex(result.prompt.final_prompt.lower(),r"\b(?:woman|person|portrait|room)\b")
    def test_prompt_count_gate_requires_explicit_plural_reference(self):
        self.assertFalse(StudioPipeline._prompt_preserves_subject_count(PromptResult(final_prompt="portrait of one woman"),2))
        self.assertTrue(StudioPipeline._prompt_preserves_subject_count(PromptResult(final_prompt="portrait of two distinct adults"),2))
    def test_subject_count_fallback_keeps_every_available_subject_entry(self):
        analysis=VisualAnalysis(subjects=[{"description":"first person with red hair"},{"description":"second person with dark hair"}])
        fallback=StudioPipeline._subject_count_fallback(analysis,2)
        self.assertIn("Exactly two distinct people",fallback)
        self.assertIn("Subject 1: first person",fallback)
        self.assertIn("Subject 2: second person",fallback)
    def test_forge_handoff_unloads_only_configured_forge_apis_and_reports_queued_jobs(self):
        with tempfile.TemporaryDirectory() as directory, patch("app.services.forge_vram_handoff.requests.post") as post:
            response=Mock(); response.raise_for_status.return_value=None; post.return_value=response
            root=Path(directory)
            (root/"1_123_456_x_kreaforge-7862.ticket").write_text(json.dumps({"instance":"kreaforge-7862"}),encoding="utf-8")
            (root/"2_123_456_x_krea2-vision-studio-7870.ticket").write_text(json.dumps({"instance":"krea2-vision-studio-7870"}),encoding="utf-8")
            handoff=ForgeVramHandoff("http://127.0.0.1:7861,http://127.0.0.1:7862",directory,handoff_token="t"*48)
            lease=QueueLease("123_assistant.ticket","n"*43)
            result=handoff.unload_forge_models(lease)
            self.assertEqual(result["unloaded"],["http://127.0.0.1:7861","http://127.0.0.1:7862"])
            self.assertEqual(post.call_count,2)
            self.assertEqual(post.call_args_list[0].args[0],f"http://127.0.0.1:7861{HANDOFF_PATH}")
            self.assertEqual(post.call_args_list[0].kwargs["headers"],{
                HANDOFF_HEADER:"t"*48,
                HANDOFF_TICKET_HEADER:lease.ticket_name,
                HANDOFF_NONCE_HEADER:lease.nonce,
            })
            self.assertEqual(handoff.queued_forge_jobs()[0]["instance"],"kreaforge-7862")
    def test_model_picker_only_lists_models_confirmed_by_ollama(self):
        with patch("app.services.model_catalog.requests.get") as get:
            response=Mock(); response.raise_for_status.return_value=None; response.json.return_value={"models":[{"name":"qwen3-vl:8b"},{"name":"unrelated:latest"}]}; get.return_value=response
            self.assertEqual(installed_qwen3_vl("http://127.0.0.1:11434"),[("Fast — Qwen3-VL 8B","qwen3-vl:8b")])
    def test_pipeline_does_not_create_or_unload_provider_when_held_handoff_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            configured=replace(settings,queue_enabled=True,backend="ollama",queue_dir=directory)
            runner=StudioPipeline(configured)
            handoff=Mock(); handoff.unload_forge_models.side_effect=RuntimeError("handoff rejected")
            with patch.object(pipeline_module,"ForgeVramHandoff",return_value=handoff), patch.object(pipeline_module,"provider_for") as create:
                with self.assertRaisesRegex(RuntimeError,"handoff rejected"):
                    with runner._provider_slot(configured,self.ollama_spec(),lambda _:None): pass
            create.assert_not_called()
    def test_pipeline_preserves_analysis_error_when_unload_also_fails(self):
        configured=replace(settings,queue_enabled=False,backend="ollama")
        runner=StudioPipeline(configured)
        provider=Mock(); provider.unload.side_effect=RuntimeError("unload failed")
        with patch.object(pipeline_module,"provider_for",return_value=provider):
            with self.assertRaisesRegex(ValueError,"analysis failed"):
                with runner._provider_slot(configured,self.ollama_spec(),lambda _:None):
                    raise ValueError("analysis failed")
        with patch.object(pipeline_module,"provider_for",return_value=provider):
            with self.assertRaisesRegex(RuntimeError,"unload failed"):
                with runner._provider_slot(configured,self.ollama_spec(),lambda _:None): pass
    @staticmethod
    def _hold(queue,entered,release):
        with queue.slot(): entered.set(); release.wait(2)
    @staticmethod
    def _enter(queue,entered):
        with queue.slot(): entered.set()

if __name__=="__main__": unittest.main()
