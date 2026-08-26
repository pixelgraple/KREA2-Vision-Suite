from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import requests

from .remote_access import RemoteAccess
from .vision_provider import ModelReply, VisionProvider


class RemoteGatewayProviderError(RuntimeError):
    pass


class RemoteGatewayProvider(VisionProvider):
    """OpenAI-compatible calls routed through the licensed KREA2 gateway."""

    def __init__(self, *, base_url: str, model: str, max_tokens: int, timeout: float, access: RemoteAccess, http: Any = requests):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.max_tokens = int(max_tokens)
        self.timeout = float(timeout)
        self.access = access
        self.http = http
        try:
            access.validate()
        except ValueError as exc:
            raise RemoteGatewayProviderError(str(exc)) from exc
        if not self.base_url.startswith("https://"):
            raise RemoteGatewayProviderError("Remote Vision gateway must use HTTPS.")
        if not 1 <= self.max_tokens <= 2048 or not 30 <= self.timeout <= 3600:
            raise RemoteGatewayProviderError("Remote Vision configuration is invalid.")

    @staticmethod
    def _mime(image_path: str | Path) -> str:
        return {".png":"image/png", ".webp":"image/webp", ".jpg":"image/jpeg", ".jpeg":"image/jpeg"}.get(Path(image_path).suffix.casefold(), "image/jpeg")

    def _messages(self, system: str, user: str, image_path: str) -> list[dict]:
        try:
            encoded = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
        except OSError as exc:
            raise RemoteGatewayProviderError("The validated image could not be read for remote Vision.") from exc
        return [{"role":"system","content":system},{"role":"user","content":[{"type":"text","text":user},{"type":"image_url","image_url":{"url":f"data:{self._mime(image_path)};base64,{encoded}"}}]}]

    def _chat(self, messages: list[dict], temperature: float, *, json_mode: bool = True, max_tokens: int | None = None) -> ModelReply:
        limit = self.max_tokens if max_tokens is None else min(int(max_tokens), self.max_tokens)
        payload = {"model":self.model,"messages":messages,"temperature":float(temperature),"max_tokens":limit,"stream":False}
        if json_mode:
            payload["response_format"] = {"type":"json_object"}
        headers = {"Authorization":self.access.authorization,"X-Krea2-Request-Id":self.access.request_id}
        try:
            response = self.http.post(f"{self.base_url}/v1/chat/completions", json=payload, headers=headers, timeout=self.timeout + 15)
            body = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise RemoteGatewayProviderError("The remote Vision gateway is unavailable.") from exc
        if response.status_code >= 400:
            detail = str(body.get("detail") or "Remote Vision request failed.") if isinstance(body, dict) else "Remote Vision request failed."
            raise RemoteGatewayProviderError(detail[:400])
        try:
            message = body["choices"][0]["message"]
            content = message.get("content") or message.get("reasoning_content")
            if not isinstance(content, str) or not content.strip():
                raise TypeError("empty response")
        except (KeyError, IndexError, TypeError) as exc:
            raise RemoteGatewayProviderError("The remote Vision gateway returned an invalid model response.") from exc
        return ModelReply(content, body.get("usage") if isinstance(body.get("usage"), dict) else {})

    def with_image(self, system: str, user: str, image_path: str, temperature: float) -> ModelReply:
        return self._chat(self._messages(system, user, image_path), temperature)

    def with_image_text(self, system: str, user: str, image_path: str, temperature: float, max_tokens: int | None = None) -> ModelReply:
        return self._chat(self._messages(system, user, image_path), temperature, json_mode=False, max_tokens=max_tokens)

    def text(self, system: str, user: str, temperature: float, max_tokens: int | None = None) -> ModelReply:
        return self._chat([{"role":"system","content":system},{"role":"user","content":user}], temperature, max_tokens=max_tokens)

    def complete_audit(self, prompt_variants: list[str]) -> None:
        headers = {"Authorization":self.access.authorization,"X-Krea2-Request-Id":self.access.request_id}
        payload = {"model_id":"vast::gemma4-26b-a4b-heretic-q3_k_l","prompt_variants":prompt_variants,"source_url":self.access.source_url}
        try:
            response = self.http.post(f"{self.base_url}/v1/audit/complete", json=payload, headers=headers, timeout=12)
            if response.status_code >= 400:
                raise RemoteGatewayProviderError("Remote audit finalization failed.")
        except requests.RequestException as exc:
            raise RemoteGatewayProviderError("Remote audit finalization failed.") from exc

    def unload(self) -> None:
        return

    close = unload
