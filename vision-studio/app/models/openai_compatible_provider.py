from __future__ import annotations
import base64
from pathlib import Path
import requests
from .vision_provider import ModelReply, VisionProvider

class OpenAICompatibleProvider(VisionProvider):
    def __init__(self, base_url, api_key, model, max_tokens):
        if not api_key: raise RuntimeError("QWEN_API_KEY is required for an OpenAI-compatible backend.")
        self.url, self.api_key, self.model, self.max_tokens = base_url.rstrip("/") + "/v1/chat/completions", api_key, model, max_tokens
    def _call(self, messages, temperature):
        try:
            response=requests.post(self.url, headers={"Authorization":f"Bearer {self.api_key}"}, json={"model":self.model,"messages":messages,"temperature":temperature,"max_tokens":self.max_tokens,"response_format":{"type":"json_object"}}, timeout=900)
            response.raise_for_status(); data=response.json(); return ModelReply(data["choices"][0]["message"].get("content", ""), data.get("usage", {}))
        except requests.RequestException as exc: raise RuntimeError(f"OpenAI-compatible backend is unavailable: {exc}") from exc
    def with_image(self, system,user,image_path,temperature):
        suffix=Path(image_path).suffix.lower(); mime="image/png" if suffix==".png" else "image/jpeg"
        b64=base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
        return self._call([{"role":"system","content":system},{"role":"user","content":[{"type":"text","text":user},{"type":"image_url","image_url":{"url":f"data:{mime};base64,{b64}","detail":"high"}}]}],temperature)
    def text(self,system,user,temperature): return self._call([{"role":"system","content":system},{"role":"user","content":user}],temperature)
