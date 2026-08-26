from __future__ import annotations
import json
from pathlib import Path
from ..schemas.prompt import PromptControls, PromptResult
from ..schemas.visual_analysis import VisualAnalysis, CriticReport, SubjectCensus
from .json_guard import instance_template
from .realism_engine import guidance

ROOT = Path(__file__).resolve().parents[1] / "prompts"


def system(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def instance_for(model) -> str:
    return instance_template(model)


def census_user() -> str:
    return (
        "Count distinct visible human subjects before describing anything else. "
        "Return one populated JSON instance with every key in this template. "
        "Do not return JSON Schema metadata such as properties, title, or type:\n"
        + instance_for(SubjectCensus)
    )


def analysis_user(census: SubjectCensus) -> str:
    return (
        f"The independently observed human-subject census is {census.human_subject_count}. "
        "Preserve that exact count unless the image itself clearly disproves it. Every "
        "visible person needs a separate subjects entry. If there are no people, do not "
        "invent a person, room, or scene; describe the actual non-human image content, "
        "including visible interface elements and text, in environment, composition, "
        "photographic_characteristics, and style_observations. Return one populated JSON "
        "instance with every key in this template. Do not return JSON Schema metadata "
        "such as properties, title, or type:\n"
        + instance_for(VisualAnalysis)
    )


def critic_user(first: VisualAnalysis, tags: list[str], census: SubjectCensus) -> str:
    return (
        f"Independent subject census: {census.model_dump_json()}. Previous analysis:\n"
        f"{first.model_dump_json()}\nWD14 supplemental tags: {json.dumps(tags)}\n"
        "Return one populated JSON instance with every key in this template; never return "
        "JSON Schema metadata:\n"
        + instance_for(CriticReport)
    )


def merger_user(census: SubjectCensus, first: VisualAnalysis, critic: CriticReport, crops: list[dict], previous: VisualAnalysis|None, locks: dict[str,bool]) -> str:
    lock_paths = {"face":"primary_subject.face","hair":"primary_subject.hair","expression":"primary_subject.expression","pose":"primary_subject.pose","outfit":"primary_subject.wardrobe","accessories":"primary_subject.accessories","environment":"environment","composition":"composition","lighting":"lighting","color_grade":"color_grade"}
    locked = [lock_paths[key] for key, value in locks.items() if value and key in lock_paths]
    lock_note = "" if not previous else f"Prior corrected analysis: {previous.model_dump_json()}. Preserve these locked evidence paths exactly unless the existing value is empty: {json.dumps(locked)}."
    return (
        "Merge pass 1 and critic into clean corrected evidence. The hard human-subject "
        f"census is {census.human_subject_count}; set subject_count to that value. When "
        "the count is zero, never invent people or a scene absent from the evidence. "
        "Critic wins only where the image supports it. Remove duplicates and unsupported "
        f"assumptions. Crop observations: {json.dumps(crops, ensure_ascii=False)}. "
        f"{lock_note}\nReturn one populated JSON instance with every key in this "
        "template; never return JSON Schema metadata:\n"
        f"{instance_for(VisualAnalysis)}\nPASS1:{first.model_dump_json()}\n"
        f"CRITIC:{critic.model_dump_json()}"
    )


def composer_user(analysis: VisualAnalysis, controls: PromptControls, previous: PromptResult|None, rewrite: str="") -> str:
    sliders = {name:getattr(controls,name) for name in ("reference_fidelity","photorealism","cinematic_look","skin_texture","environment_detail","clothing_detail","pose_detail","lighting_detail","color_grade_detail","camera_detail")}
    section_names = {"face":"face","hair":"hair","expression":"expression","pose":"pose","outfit":"clothing","accessories":"accessories","environment":"environment","composition":"composition","lighting":"lighting","color_grade":"color_grade"}
    locked = [section_names[key] for key, value in controls.locks.items() if value and key in section_names]
    return json.dumps(
        {
            "exact_human_subject_count": analysis.subject_count,
            "corrected_visual_evidence": analysis.model_dump(),
            "reference_analysis_mode": controls.mode,
            "detail_level": controls.detail,
            "content_mode": controls.content_mode,
            "realism_enhancement": controls.realism,
            "realism_guidance": guidance(controls),
            "composer_weights": sliders,
            "additional_instructions": controls.additional_instructions,
            "locked_sections": locked,
            "previous_prompt": previous.model_dump() if previous else None,
            "rewrite_instruction": rewrite,
            "negative_prompt_enabled": controls.generate_negative,
            "output_contract": {
                "populated_json_instance_template": json.loads(instance_for(PromptResult)),
                "required_section_keys": [
                    "subject", "face", "hair", "expression", "pose", "clothing",
                    "accessories", "environment", "composition", "lighting",
                    "texture_realism", "color_grade",
                ],
                "rules": [
                    "use only corrected_visual_evidence",
                    "never invent people, objects, rooms, text, or scenes",
                    "negative_prompt must be deduplicated and contain at most 80 terms",
                    "return a populated JSON instance, never metadata or a wrapper",
                ],
            },
        },
        ensure_ascii=False,
    )
