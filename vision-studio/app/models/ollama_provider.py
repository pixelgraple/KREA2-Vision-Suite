from __future__ import annotations
import base64
from pathlib import Path
import requests
from .vision_provider import ModelReply, VisionProvider

class OllamaProvider(VisionProvider):
    def __init__(self, base_url: str, model: str, context: int, max_tokens: int, keep_alive: str):
        self.base_url, self.model = base_url.rstrip("/"), model
        self.context, self.max_tokens, self.keep_alive = context, max_tokens, keep_alive

    def _chat(self, messages, temperature: float) -> ModelReply:
        try:
            response = requests.post(f"{self.base_url}/api/chat", json={
                "model": self.model, "messages": messages, "stream": False, "format": "json",
                "think": False,
                "keep_alive": self.keep_alive,
                "options": {"temperature": temperature, "num_ctx": self.context, "num_predict": self.max_tokens},
            }, timeout=900)
            response.raise_for_status()
            payload = response.json()
            return ModelReply(payload.get("message", {}).get("content", ""), {key: payload[key] for key in ("prompt_eval_count", "eval_count", "total_duration", "load_duration") if key in payload})
        except requests.RequestException as exc:
            raise RuntimeError(f"Qwen3-VL / Ollama is unavailable at {self.base_url}. Start Ollama and pull the configured model. {exc}") from exc

    def with_image(self, system, user, image_path, temperature):
        encoded = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
        return self._chat([{"role": "system", "content": system}, {"role": "user", "content": user, "images": [encoded]}], temperature)

    def text(self, system, user, temperature):
        return self._chat([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature)

    def unload(self) -> None:
        try:
            response = requests.post(
                f"{self.base_url}/api/generate",
                json={"model": self.model, "prompt": "", "stream": False, "keep_alive": 0},
                timeout=60,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise RuntimeError(f"Ollama completed the interrogation but could not release Qwen3-VL VRAM: {exc}") from exc
