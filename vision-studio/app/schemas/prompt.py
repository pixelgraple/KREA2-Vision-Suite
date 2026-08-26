from __future__ import annotations
from pydantic import BaseModel, Field
from .visual_analysis import CriticReport, VisualAnalysis

class PromptControls(BaseModel):
    mode: str = "Exact Reference"
    detail: str = "Obsessive Detail"
    content_mode: str = "Auto"
    realism: str = "NORMAL"
    generate_negative: bool = True
    deep_inspection: bool = True
    use_wd14: bool = False
    reference_fidelity: int = 90
    photorealism: int = 85
    cinematic_look: int = 45
    skin_texture: int = 80
    environment_detail: int = 75
    clothing_detail: int = 90
    pose_detail: int = 90
    lighting_detail: int = 85
    color_grade_detail: int = 80
    camera_detail: int = 70
    locks: dict[str, bool] = Field(default_factory=dict)
    additional_instructions: str = ""

class PromptResult(BaseModel):
    final_prompt: str
    negative_prompt: str = ""
    sections: dict[str, str] = Field(default_factory=dict)

class StudioState(BaseModel):
    pass1: VisualAnalysis
    critic: CriticReport
    merged: VisualAnalysis
    prompt: PromptResult
    wd14_tags: list[str] = Field(default_factory=list)
    debug: dict = Field(default_factory=dict)
