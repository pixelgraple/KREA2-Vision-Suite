from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field

class SubjectCensus(BaseModel):
    human_subject_count: int = 0
    subjects: list[dict[str, Any]] = Field(default_factory=list)
    uncertainty: str = ""

class VisualAnalysis(BaseModel):
    subject_count: int = 0
    subjects: list[dict[str, Any]] = Field(default_factory=list)
    primary_subject: dict[str, Any] = Field(default_factory=dict)
    environment: dict[str, Any] = Field(default_factory=dict)
    composition: dict[str, Any] = Field(default_factory=dict)
    lighting: dict[str, Any] = Field(default_factory=dict)
    textures: dict[str, Any] = Field(default_factory=dict)
    color_grade: dict[str, Any] = Field(default_factory=dict)
    photographic_characteristics: dict[str, Any] = Field(default_factory=dict)
    style_observations: list[dict[str, Any] | str] = Field(default_factory=list)
    uncertainties: list[dict[str, Any] | str] = Field(default_factory=list)

class CriticReport(BaseModel):
    confirmed_observations: list[dict[str, Any] | str] = Field(default_factory=list)
    corrections: list[dict[str, Any] | str] = Field(default_factory=list)
    additions: list[dict[str, Any] | str] = Field(default_factory=list)
    removed_assumptions: list[dict[str, Any] | str] = Field(default_factory=list)
    remaining_uncertainties: list[dict[str, Any] | str] = Field(default_factory=list)

class Evaluation(BaseModel):
    subject_accuracy: int = 0
    hair_accuracy: int = 0
    face_accuracy: int = 0
    pose_accuracy: int = 0
    outfit_accuracy: int = 0
    environment_accuracy: int = 0
    lighting_accuracy: int = 0
    composition_accuracy: int = 0
    color_grade_accuracy: int = 0
    overall_reference_fidelity: int = 0
    omissions: list[str] = Field(default_factory=list)
    notes: str = ""
