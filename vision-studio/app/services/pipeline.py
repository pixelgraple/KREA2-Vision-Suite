from __future__ import annotations
import re
import time
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Callable
from ..config import Settings, ROOT
from ..models.factory import provider_for
from ..schemas.prompt import PromptControls, PromptResult, StudioState
from ..schemas.visual_analysis import CriticReport, Evaluation, SubjectCensus, VisualAnalysis
from .json_guard import instance_template, looks_like_schema, parse_or_repair
from .gpu_telemetry import (
    GpuMemory,
    GpuTelemetryError,
    MeasuredPeakStore,
    PeakMemoryPoller,
    query_gpu_memory,
)
from .model_catalog import ModelSpec, resolve_model
from .prompts import analysis_user, census_user, composer_user, critic_user, merger_user, system
from .shared_queue import SharedGenerationQueue
from .forge_vram_handoff import ForgeVramHandoff
from .ollama_vram_handoff import OllamaVramHandoff
from .wd14 import tags as wd14_tags
from .history import HistoryStore


# NVML free-memory readings fluctuate by a few MiB as desktop CUDA clients
# allocate asynchronously. Keep the requested 4096 MiB reserve intact while
# allowing only a tightly bounded observation tolerance at the admission edge.
VRAM_ADMISSION_JITTER_MB = 64


class GpuCapacityError(RuntimeError):
    pass


class ProviderTeardownError(RuntimeError):
    """A local-GPU provider could not prove that its VRAM-owning child stopped."""

    def __init__(self, operation_error: BaseException | None = None):
        super().__init__(
            "Critical local Vision cleanup failure: the provider did not unload cleanly."
        )
        self.operation_error = operation_error


class StudioPipeline:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.history = HistoryStore(ROOT)
        telemetry_path = Path(settings.llama_cpp_telemetry_path).expanduser()
        if not telemetry_path.is_absolute():
            telemetry_path = ROOT / telemetry_path
        self.telemetry = MeasuredPeakStore(telemetry_path)

    def _select_spec(self, public_id: str | None = None) -> ModelSpec:
        backend = self.settings.backend.lower()
        if public_id in {None, "openai_compatible::configured"} and backend in {
            "openai",
            "openai_compatible",
        }:
            return ModelSpec(
                public_id="openai_compatible::configured",
                label="Configured OpenAI-compatible model",
                backend="openai_compatible",
                provider_model=self.settings.model,
                local_gpu=False,
                context_cap=self.settings.context_length,
                max_output_cap=self.settings.max_output_tokens,
                estimated_vram_mb=0,
            )
        return resolve_model(public_id or self.settings.model, self.settings)

    def _active_settings(self, spec: ModelSpec) -> Settings:
        context = max(512, min(self.settings.context_length, spec.context_cap))
        max_output = max(
            1,
            min(self.settings.max_output_tokens, spec.max_output_cap, context - 1),
        )
        return replace(
            self.settings,
            backend=spec.backend,
            model=spec.public_id,
            context_length=context,
            max_output_tokens=max_output,
        )

    def queue(self, active_settings: Settings, spec: ModelSpec):
        return SharedGenerationQueue(
            f"babegen-prompt-assistant-krea2-vision-studio-{active_settings.port}",
            active_settings.queue_enabled and spec.local_gpu,
            active_settings.queue_dir,
            active_settings.queue_poll_seconds,
            active_settings.queue_stale_seconds,
        )

    def _capacity_for(self, active_settings: Settings, spec: ModelSpec) -> tuple[dict, GpuMemory]:
        previous = self.telemetry.get(
            spec.public_id,
            context_length=active_settings.context_length,
        ) or {}
        measured = max(0, int(previous.get("peak_delta_mb") or 0))
        headroom = max(0, active_settings.llama_cpp_vram_headroom_mb)
        allocation_target = max(0, active_settings.llama_cpp_model_allocation_target_mb)
        required = max(spec.estimated_vram_mb, measured) + headroom
        deadline = time.monotonic() + min(30.0, max(5.0, active_settings.forge_unload_timeout_seconds))
        while True:
            try:
                current = query_gpu_memory()
            except GpuTelemetryError as exc:
                raise GpuCapacityError(
                    "GPU memory could not be verified after Forge handoff; local Vision stopped safely."
                ) from exc
            if current.free_mb + VRAM_ADMISSION_JITTER_MB >= required or time.monotonic() >= deadline:
                break
            time.sleep(0.5)
        capacity = {
            "model_id": spec.public_id,
            "estimated_vram_mb": spec.estimated_vram_mb,
            "last_measured_peak_mb": measured,
            "headroom_mb": headroom,
            "model_allocation_target_mb": allocation_target,
            "estimate_exceeds_target": bool(
                allocation_target and spec.estimated_vram_mb > allocation_target
            ),
            "required_vram_mb": required,
            "free_vram_mb_after_handoff": current.free_mb,
            "admission_tolerance_mb": VRAM_ADMISSION_JITTER_MB,
        }
        if current.free_mb + VRAM_ADMISSION_JITTER_MB < required:
            raise GpuCapacityError(
                f"Local Vision needs {required} MiB of free VRAM after Forge handoff, "
                f"but only {current.free_mb} MiB is available after the bounded "
                f"{VRAM_ADMISSION_JITTER_MB} MiB measurement tolerance."
            )
        return capacity, current

    @contextmanager
    def _provider_slot(
        self,
        active_settings: Settings,
        spec: ModelSpec,
        progress,
        *,
        provider_supplier: Callable[[], object | None] | None = None,
        retain_provider: Callable[[object, object], bool] | None = None,
        cancel_check: Callable[[], None] | None = None,
        queue_timeout_seconds: float | None = None,
        remote_access=None,
    ):
        if spec.backend == "llama_cpp" and not active_settings.queue_enabled:
            raise GpuCapacityError(
                "The llama.cpp Vision backend requires the shared local-GPU queue; "
                "it stopped safely because that queue is disabled."
            )
        queue_slot = self.queue(active_settings, spec)
        slot_options = {}
        if cancel_check is not None:
            slot_options["cancel_check"] = cancel_check
        if queue_timeout_seconds is not None:
            slot_options["timeout_seconds"] = queue_timeout_seconds
        slot_context = queue_slot.slot(progress, **slot_options)
        with slot_context as lease:
            handoff=ForgeVramHandoff(active_settings.forge_unload_urls,active_settings.queue_dir,active_settings.forge_unload_timeout_seconds,active_settings.forge_handoff_token_file)
            provider=None
            poller=None
            capacity={"model_id":spec.public_id,"check":"not required for this backend"}
            body_error=None
            retained=False
            retain_error=None
            try:
                warm_provider=provider_supplier() if provider_supplier is not None else None
                if warm_provider is not None:
                    provider=warm_provider
                    handoff_before={"skipped":"reused warm Heretic provider"}
                    capacity={"model_id":spec.public_id,"check":"reused warm Heretic provider"}
                    progress("Reusing the warm Heretic provider")
                elif active_settings.queue_enabled and spec.local_gpu:
                    progress("Releasing Forge and Ollama VRAM for local Vision")
                    forge_handoff=handoff.unload_forge_models(lease)
                    if spec.backend == "llama_cpp":
                        ollama_handoff=OllamaVramHandoff(
                            active_settings.api_base,
                            active_settings.forge_unload_timeout_seconds,
                        ).unload_models(lease)
                    else:
                        ollama_handoff={"skipped":"selected provider is Ollama"}
                    handoff_before={"forge":forge_handoff,"ollama":ollama_handoff}
                    progress("Verifying free VRAM for the selected local Vision model")
                    capacity,baseline=self._capacity_for(active_settings,spec)
                    poller=PeakMemoryPoller(sample=query_gpu_memory)
                    poller.observe(baseline)
                    poller.start()
                else:
                    handoff_before={"skipped":"shared local-GPU queue or local GPU backend is disabled"}
                if provider is None:
                    provider_settings=replace(active_settings,keep_alive="5m") if spec.backend=="ollama" else active_settings
                    provider=provider_for(provider_settings,spec,remote_access=remote_access)
                yield provider,handoff,handoff_before,capacity
            except BaseException as exc:
                body_error=exc
                raise
            finally:
                cleanup_error=None
                release=getattr(provider,"unload",None) if provider is not None else None
                if poller is not None:
                    measurement=poller.stop()
                    if measurement.samples:
                        try:
                            self.telemetry.record(
                                spec.public_id,
                                measurement,
                                context_length=active_settings.context_length,
                            )
                        except GpuTelemetryError:
                            pass
                if provider is not None and retain_provider is not None and body_error is None:
                    try:
                        retained=bool(retain_provider(provider,lease))
                    except Exception as exc:
                        retain_error=exc
                if not retained and callable(getattr(provider,"unload",None)):
                    progress("Releasing local Vision model VRAM")
                    try:
                        provider.unload()
                    except Exception as exc:
                        cleanup_error=cleanup_error or exc
                if cleanup_error is not None:
                    if active_settings.queue_enabled and spec.local_gpu:
                        raise ProviderTeardownError(body_error) from cleanup_error
                    if body_error is None:
                        raise cleanup_error
                if retain_error is not None and body_error is None:
                    raise retain_error
                if cleanup_error is not None and body_error is None:
                    raise cleanup_error
    @staticmethod
    def _prompt_preserves_subject_count(prompt: PromptResult, count: int) -> bool:
        if count < 2: return True
        final_text=prompt.final_prompt.lower()
        subject_text=prompt.sections.get("subject","").lower()
        words={2:("two","2","both"),3:("three","3","all three"),4:("four","4","all four")}
        markers=words.get(count,(str(count),))
        return any(marker in final_text for marker in markers) and (not subject_text or any(marker in subject_text for marker in markers))
    @staticmethod
    def _subject_count_fallback(analysis: VisualAnalysis, count: int) -> str:
        words={2:"two",3:"three",4:"four"}
        count_label=words.get(count,str(count))
        entries=[]
        for index,subject in enumerate(analysis.subjects[:count],start=1):
            description=str(subject.get("description","")).strip() if isinstance(subject,dict) else str(subject).strip()
            if description: entries.append(f"Subject {index}: {description}")
        details=" ".join(entries)
        return f"Exactly {count_label} distinct people are visible together in the frame. {details}".strip()

    @staticmethod
    def _analysis_has_evidence(analysis: VisualAnalysis) -> bool:
        return any(
            bool(value)
            for value in (
                analysis.subjects,
                analysis.primary_subject,
                analysis.environment,
                analysis.composition,
                analysis.lighting,
                analysis.textures,
                analysis.color_grade,
                analysis.photographic_characteristics,
                analysis.style_observations,
                analysis.uncertainties,
            )
        )

    @staticmethod
    def _prompt_invents_humans(prompt: PromptResult, count: int) -> bool:
        if count != 0:
            return False
        return bool(
            re.search(
                r"\b(?:man|men|woman|women|person|people|boy|boys|girl|girls|"
                r"couple|human|male|female|portrait|subject's)\b",
                prompt.final_prompt,
                re.IGNORECASE,
            )
        )

    @staticmethod
    def _normalize_negative_prompt(text: str, limit: int = 80) -> str:
        unique = []
        seen = set()
        for raw in re.split(r"[,;\n]+", text):
            term = re.sub(r"\s+", " ", raw).strip()
            key = term.casefold()
            if not term or key in seen:
                continue
            seen.add(key)
            unique.append(term)
            if len(unique) >= limit:
                break
        return ", ".join(unique)

    @staticmethod
    def _flatten_evidence(value) -> str:
        if isinstance(value,dict):
            parts=[]
            for key,item in value.items():
                rendered=StudioPipeline._flatten_evidence(item)
                if rendered:
                    parts.append(f"{str(key).replace('_',' ')}: {rendered}")
            return "; ".join(parts)
        if isinstance(value,list):
            return "; ".join(
                rendered
                for item in value
                if (rendered:=StudioPipeline._flatten_evidence(item))
            )
        return str(value).strip() if value is not None else ""

    @staticmethod
    def _nonhuman_prompt_fallback(analysis: VisualAnalysis) -> PromptResult:
        def safe_nonhuman(value) -> str:
            rendered=StudioPipeline._flatten_evidence(value)
            return "; ".join(
                part.strip()
                for part in rendered.split(";")
                if part.strip() and not re.search(
                    r"\b(?:man|men|woman|women|person|people|boy|boys|girl|girls|couple|human|male|female|portrait)\b",
                    part,
                    re.IGNORECASE,
                )
            )
        evidence={
            "environment":safe_nonhuman(analysis.environment),
            "composition":safe_nonhuman(analysis.composition),
            "lighting":safe_nonhuman(analysis.lighting),
            "texture_realism":safe_nonhuman(analysis.textures),
            "color_grade":safe_nonhuman(analysis.color_grade),
            "photographic_characteristics":safe_nonhuman(analysis.photographic_characteristics),
            "style":safe_nonhuman(analysis.style_observations),
        }
        labels={
            "environment":"Visible content",
            "composition":"Composition",
            "lighting":"Lighting",
            "texture_realism":"Texture and material appearance",
            "color_grade":"Color finish",
            "photographic_characteristics":"Image characteristics",
            "style":"Style observations",
        }
        sentences=[f"{labels[key]}: {value}." for key,value in evidence.items() if value]
        final_prompt=(
            "Recreate the reference exactly using only the observed visual evidence. "
            +" ".join(sentences)
        ).strip()
        sections={
            "subject":"",
            "face":"",
            "hair":"",
            "expression":"",
            "pose":"",
            "clothing":"",
            "accessories":"",
            "environment":evidence["environment"],
            "composition":evidence["composition"],
            "lighting":evidence["lighting"],
            "texture_realism":evidence["texture_realism"],
            "color_grade":evidence["color_grade"],
        }
        return PromptResult(
            final_prompt=final_prompt,
            negative_prompt="people, human figures, portraits",
            sections=sections,
        )
    def analyze(self,image:Path,image_hash:str,controls:PromptControls,progress=lambda x:None,prior:StudioState|None=None,model: str|None=None) -> StudioState:
        spec=self._select_spec(model); active_settings=self._active_settings(spec)
        started=time.perf_counter(); debug={"model":spec.public_id,"backend":spec.backend,"stages":[]}
        with self._provider_slot(active_settings,spec,progress) as (provider,handoff,handoff_before,gpu_capacity):
            debug["forge_handoff_before"]=handoff_before
            debug["gpu_capacity"]=gpu_capacity
            progress("1/7 — Qwen3-VL subject census")
            raw0=provider.with_image("You are a strict visual census system. Return only a populated JSON instance, never a schema.",census_user(),str(image),active_settings.temp_analysis)
            if looks_like_schema(raw0.text,SubjectCensus):
                debug["subject_census_schema_output"]=raw0.text
                progress("1/7 — Retrying schema-only subject census against the image")
                raw0=provider.with_image(
                    "Inspect the image pixels. Return a populated subject-census JSON instance, never schema metadata.",
                    "Your previous response echoed a schema instead of counting the image. Perform the count now.\n"+census_user(),
                    str(image),
                    active_settings.temp_analysis,
                )
                debug["stages"].append("subject_census_schema_retry")
            census=parse_or_repair(raw0,SubjectCensus,provider,active_settings.temp_merger)
            debug["subject_census_output"]=raw0.text; debug["subject_census"]=census.model_dump(); debug["stages"].append("subject_census")
            progress("2/7 — Qwen3-VL objective visual analysis")
            raw1=provider.with_image(system("qwen_visual_analysis.txt"),analysis_user(census),str(image),active_settings.temp_analysis)
            first=parse_or_repair(raw1,VisualAnalysis,provider,active_settings.temp_merger)
            debug["pass1_output"]=raw1.text
            if not self._analysis_has_evidence(first):
                progress("2/7 — Retrying empty visual evidence against the image")
                retry1=provider.with_image(
                    system("qwen_visual_analysis.txt"),
                    "The previous response contained no usable image evidence or merely echoed a template. Inspect the actual pixels now. Populate every key with supported observations or empty values, and include concrete non-human content when no person is visible.\n"+analysis_user(census),
                    str(image),
                    active_settings.temp_analysis,
                )
                first=parse_or_repair(retry1,VisualAnalysis,provider,active_settings.temp_merger)
                debug["pass1_evidence_retry_output"]=retry1.text
                debug["stages"].append("pass1_evidence_retry")
            if not self._analysis_has_evidence(first):
                raise RuntimeError("Qwen returned no grounded visual evidence after reinspecting the image; prompt composition stopped safely.")
            debug["stages"].append("pass1")
            crop_evidence=[]
            if controls.deep_inspection and census.human_subject_count > 0:
                from .image_processor import ImageProcessor
                progress("3/7 — Deep inspection crops")
                for label,crop in ImageProcessor(1,1,1).crops(image,image.parent):
                    reply=provider.with_image(system("qwen_visual_analysis.txt"),f"This crop shows {label}. Return only genuinely visible observations as one populated JSON instance with every expected key; never return schema metadata.",str(crop),active_settings.temp_analysis)
                    crop_evidence.append({"region":label,"analysis":parse_or_repair(reply,VisualAnalysis,provider,active_settings.temp_merger).model_dump()})
                debug["crop_observations"]=crop_evidence; debug["stages"].append("deep_inspection")
            elif controls.deep_inspection:
                debug["deep_inspection_skipped"]="No human subjects were found, so person-biased face/torso/body crops were skipped."
            tags=[]
            if controls.use_wd14:
                progress("3/7 — WD14 supplemental evidence")
                tags=wd14_tags(str(image),self.settings.wd14_model,self.settings.wd14_device); debug["wd14_tags"]=tags
            progress("4/7 — Qwen3-VL visual critique")
            raw2=provider.with_image(system("qwen_visual_critic.txt"),critic_user(first,tags,census),str(image),active_settings.temp_critic); critic=parse_or_repair(raw2,CriticReport,provider,active_settings.temp_merger); debug["pass2_output"]=raw2.text; debug["stages"].append("pass2")
            progress("5/7 — Reconciling visual evidence")
            raw3=provider.text("You are a precise evidence merger. Return only valid JSON.",merger_user(census,first,critic,crop_evidence,prior.merged if prior else None,controls.locks),active_settings.temp_merger); merged=parse_or_repair(raw3,VisualAnalysis,provider,active_settings.temp_merger); debug["merged_output"]=raw3.text; debug["stages"].append("merge")
            if not self._analysis_has_evidence(merged):
                progress("5/7 — Retrying empty merged evidence")
                retry3=provider.text(
                    "Merge only supplied evidence into one populated JSON instance. Never return a schema or invent facts.",
                    "The previous merge was empty or schema-only. Preserve the grounded pass-1 observations and apply only supported critic corrections.\n"+merger_user(census,first,critic,crop_evidence,prior.merged if prior else None,controls.locks),
                    active_settings.temp_merger,
                )
                merged=parse_or_repair(retry3,VisualAnalysis,provider,active_settings.temp_merger)
                debug["merge_evidence_retry_output"]=retry3.text
                debug["stages"].append("merge_evidence_retry")
            if not self._analysis_has_evidence(merged):
                merged=first.model_copy(deep=True)
                debug["merge_grounded_fallback"]="The text-only merger remained empty; retained the image-grounded first pass instead of composing from blank evidence."
            if census.human_subject_count >= 2 and (merged.subject_count != census.human_subject_count or len(merged.subjects) < census.human_subject_count):
                progress("5/7 — Repairing subject-count mismatch from original image")
                retry=provider.with_image(system("qwen_visual_analysis.txt"),f"STRUCTURAL FAILURE: the independent image census found {census.human_subject_count} people, but the merged analysis dropped someone. Reinspect the original image. Return a corrected full analysis with subject_count exactly {census.human_subject_count} and separate detailed entries for every person.\n"+analysis_user(census),str(image),active_settings.temp_analysis)
                merged=parse_or_repair(retry,VisualAnalysis,provider,active_settings.temp_merger); debug["subject_count_repair_output"]=retry.text; debug["stages"].append("subject_count_repair")
            merged.subject_count=census.human_subject_count
            if not self._analysis_has_evidence(merged):
                raise RuntimeError("No grounded visual evidence remained after reconciliation; prompt composition stopped safely.")
            progress("6/7 — Writing KREA2 prompt")
            raw4=provider.text(system("krea2_prompt_writer.txt"),composer_user(merged,controls,prior.prompt if prior else None),active_settings.temp_composer); prompt=parse_or_repair(raw4,PromptResult,provider,active_settings.temp_merger); debug["composer_output"]=raw4.text; debug["stages"].append("composer")
            if not prompt.final_prompt.strip() or self._prompt_invents_humans(prompt,census.human_subject_count):
                progress("6/7 — Repairing ungrounded prompt output")
                grounding_instruction=(
                    "The previous output was empty or contradicted the corrected evidence. Rewrite from the corrected evidence only. "
                    "The exact human-subject count is zero, so remove every invented person, portrait, human action, room, and scene; describe only actual visible non-human content."
                    if census.human_subject_count==0
                    else "The previous output was empty or contradicted the corrected evidence. Rewrite from the corrected evidence only without inventing facts."
                )
                grounded_prompt=provider.text(
                    system("krea2_prompt_writer.txt"),
                    composer_user(merged,controls,prompt,grounding_instruction),
                    active_settings.temp_composer,
                )
                prompt=parse_or_repair(grounded_prompt,PromptResult,provider,active_settings.temp_merger)
                debug["grounding_prompt_repair_output"]=grounded_prompt.text
                debug["stages"].append("grounding_prompt_repair")
            if not prompt.final_prompt.strip() or self._prompt_invents_humans(prompt,census.human_subject_count):
                if census.human_subject_count==0:
                    prompt=self._nonhuman_prompt_fallback(merged)
                    if not prompt.final_prompt.strip() or self._prompt_invents_humans(prompt,0):
                        raise RuntimeError("The prompt writer contradicted the grounded subject census after a strict retry; the result was not saved.")
                    debug["grounded_composer_fallback"]="The model repeatedly invented a person for a zero-person image; the final prompt was composed deterministically from merged visual evidence only."
                    debug["stages"].append("grounded_composer_fallback")
                else:
                    raise RuntimeError("The prompt writer contradicted the grounded subject census after a strict retry; the result was not saved.")
            if not self._prompt_preserves_subject_count(prompt,census.human_subject_count):
                progress("6/7 — Repairing prompt subject-count mismatch")
                retry_prompt=provider.text(system("krea2_prompt_writer.txt"),composer_user(merged,controls,prompt,f"The previous prompt failed the non-negotiable count of exactly {census.human_subject_count} people. Rewrite the full prompt to explicitly start by identifying exactly that many distinct subjects and separately preserve their appearance, pose, clothing, and relationship."),active_settings.temp_composer)
                prompt=parse_or_repair(retry_prompt,PromptResult,provider,active_settings.temp_merger); debug["subject_count_prompt_repair_output"]=retry_prompt.text; debug["stages"].append("subject_count_prompt_repair")
                if not self._prompt_preserves_subject_count(prompt,census.human_subject_count):
                    fallback=self._subject_count_fallback(merged,census.human_subject_count)
                    prompt.final_prompt=f"{fallback} {prompt.final_prompt}".strip()
                    prompt.sections["subject"]=fallback
                    debug["subject_count_fallback"]=fallback
            if controls.generate_negative:
                prompt.negative_prompt=self._normalize_negative_prompt(prompt.negative_prompt)
            else:
                prompt.negative_prompt=""
            debug["processing_seconds"]=round(time.perf_counter()-started,2); debug["metrics"]={"census":raw0.metrics,"pass1":raw1.metrics,"pass2":raw2.metrics,"merge":raw3.metrics,"composer":raw4.metrics}
            queued_forge_jobs=handoff.queued_forge_jobs()
            action="release shared queue so queued Forge jobs load their own models" if queued_forge_jobs else "leave Forge models unloaded; no Forge job is queued"
            debug["forge_handoff_after"]={"queued_forge_jobs":queued_forge_jobs,"action":action}
            progress(f"{len(queued_forge_jobs)} Forge job(s) queued; handing the GPU back" if queued_forge_jobs else "No Forge jobs queued; leaving Forge models unloaded")
        # History contains only a hash and text/settings by default; source files/thumbnails are never stored in privacy mode.
        self.history.add(image_hash,prompt,controls.model_dump(),spec.public_id,controls.additional_instructions)
        progress("7/7 — Complete")
        return StudioState(pass1=first,critic=critic,merged=merged,prompt=prompt,wd14_tags=tags,debug=debug)
    def recompose(self,state:StudioState,controls:PromptControls,rewrite:str,progress=lambda x:None,model: str|None=None) -> StudioState:
        requested=model or str(state.debug.get("model") or "") or None
        spec=self._select_spec(requested); active_settings=self._active_settings(spec)
        if not self._analysis_has_evidence(state.merged):
            raise RuntimeError("Cannot recompose from empty visual evidence. Reinspect the image first.")
        with self._provider_slot(active_settings,spec,progress) as (provider,_,_,gpu_capacity):
            progress("Writing revised KREA2 prompt")
            raw=provider.text(system("krea2_prompt_writer.txt"),composer_user(state.merged,controls,state.prompt,rewrite),active_settings.temp_composer); state.prompt=parse_or_repair(raw,PromptResult,provider,active_settings.temp_merger); state.debug["composer_output"]=raw.text; state.debug["recompose_metrics"]=raw.metrics
            state.debug["model"]=spec.public_id; state.debug["backend"]=spec.backend; state.debug["gpu_capacity"]=gpu_capacity
            if not state.prompt.final_prompt.strip() or self._prompt_invents_humans(state.prompt,state.merged.subject_count):
                raise RuntimeError("The revised prompt contradicted the grounded subject census; the prior prompt was preserved.")
            if controls.generate_negative:
                state.prompt.negative_prompt=self._normalize_negative_prompt(state.prompt.negative_prompt)
            else:
                state.prompt.negative_prompt=""
        return state
    def evaluate(self,image:Path,prompt:str,progress=lambda x:None,model: str|None=None):
        spec=self._select_spec(model); active_settings=self._active_settings(spec)
        with self._provider_slot(active_settings,spec,progress) as (provider,_,_,_):
            progress("Comparing prompt with reference")
            reply=provider.with_image(system("prompt_evaluator.txt"),f"Prompt to audit:\n{prompt}\nReturn one populated JSON instance with every key in this template; never return schema metadata:\n{instance_template(Evaluation)}",str(image),active_settings.temp_critic); return parse_or_repair(reply,Evaluation,provider,active_settings.temp_merger)
