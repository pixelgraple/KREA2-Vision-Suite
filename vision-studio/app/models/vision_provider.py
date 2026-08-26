from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

@dataclass
class ModelReply:
    text: str
    metrics: dict = field(default_factory=dict)

class VisionProvider(ABC):
    @abstractmethod
    def with_image(self, system: str, user: str, image_path: str, temperature: float) -> ModelReply: ...
    @abstractmethod
    def text(self, system: str, user: str, temperature: float) -> ModelReply: ...
