from __future__ import annotations

import base64
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Callable

from .vision_provider import ModelReply, VisionProvider


ENDPOINT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\Z")


class VastServerlessProviderError(RuntimeError):
    pass


class VastServerlessProvider(VisionProvider):
    """OpenAI-compatible llama.cpp calls routed through Vast Serverless."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        model: str,
        max_tokens: int,
        timeout: float,
        python_exe: str | Path,
        bridge_script: str | Path,
        progress_callback: Callable[[str], None] | None = None,
        runner=None,
    ):
        self.endpoint = str(endpoint).strip()
        self.api_key = str(api_key)
        self.model = str(model)
        self.max_tokens = int(max_tokens)
        self.timeout = float(timeout)
        self.python_exe = Path(python_exe).expanduser()
        self.bridge_script = Path(bridge_script)
        self.progress_callback = progress_callback
        self._run = runner or subprocess.run
        self._request_count = 0
        self._validate()

    def _validate(self) -> None:
        if not ENDPOINT_RE.fullmatch(self.endpoint):
            raise VastServerlessProviderError("The Vast Serverless endpoint name is invalid.")
        if len(self.api_key) < 24:
            raise VastServerlessProviderError("The Vast Serverless API key is missing or invalid.")
        if not MODEL_RE.fullmatch(self.model):
            raise VastServerlessProviderError("The remote model alias is invalid.")
        if not 1 <= self.max_tokens <= 16384:
            raise VastServerlessProviderError("The remote output limit is invalid.")
        if not 30 <= self.timeout <= 3600:
            raise VastServerlessProviderError("The remote request timeout is invalid.")
        if not self.python_exe.is_file() or not self.bridge_script.is_file():
            raise VastServerlessProviderError("The isolated Vast SDK bridge is not installed.")

    @staticmethod
    def _image_mime(image_path: str | Path) -> str:
        return {
            ".png": "image/png",
            ".webp": "image/webp",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
        }.get(Path(image_path).suffix.casefold(), "image/jpeg")

    def _image_messages(self, system: str, user: str, image_path: str) -> list[dict]:
        try:
            image_bytes = Path(image_path).read_bytes()
        except OSError as exc:
            raise VastServerlessProviderError("The validated image could not be read for remote inference.") from exc
        encoded = base64.b64encode(image_bytes).decode("ascii")
        data_uri = f"data:{self._image_mime(image_path)};base64,{encoded}"
        return [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": data_uri}},
                ],
            },
        ]

    def _chat(
        self,
        messages: list[dict],
        temperature: float,
        *,
        json_mode: bool = True,
        max_tokens: int | None = None,
    ) -> ModelReply:
        output_limit = self.max_tokens if max_tokens is None else min(int(max_tokens), self.max_tokens)
        if output_limit < 1:
            raise VastServerlessProviderError("The remote per-request output limit is invalid.")
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": float(temperature),
            "max_tokens": output_limit,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        bridge_input = {
            "endpoint": self.endpoint,
            "payload": payload,
            "cost": output_limit,
            "timeout": self.timeout,
        }
        if self.progress_callback is not None:
            self.progress_callback(
                "Waking remote Gemma 4 26B-A4B GPU — the request will wait safely for Serverless capacity"
                if self._request_count == 0
                else "Using the awake remote Gemma 4 26B-A4B Serverless worker"
            )
        env = os.environ.copy()
        env["VAST_API_KEY"] = self.api_key
        try:
            completed = self._run(
                [str(self.python_exe), str(self.bridge_script)],
                input=json.dumps(bridge_input),
                text=True,
                capture_output=True,
                timeout=self.timeout + 30,
                env=env,
                shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
            response = json.loads(completed.stdout or "{}")
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            raise VastServerlessProviderError("The Vast Serverless bridge failed.") from exc
        if completed.returncode != 0 or not isinstance(response, dict) or not response.get("ok"):
            detail = response.get("error") if isinstance(response, dict) else None
            raise VastServerlessProviderError(
                f"The remote Gemma worker is unavailable: {str(detail or 'unknown bridge error')[:500]}"
            )
        data = response.get("result")
        try:
            message = data["choices"][0]["message"]
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                content = message.get("reasoning_content")
            if not isinstance(content, str) or not content.strip():
                raise TypeError("response content was empty")
            usage = data.get("usage", {})
        except (KeyError, IndexError, TypeError) as exc:
            raise VastServerlessProviderError("The remote Gemma worker returned an invalid response.") from exc
        self._request_count += 1
        return ModelReply(content, usage if isinstance(usage, dict) else {})

    def with_image(self, system: str, user: str, image_path: str, temperature: float) -> ModelReply:
        return self._chat(self._image_messages(system, user, image_path), temperature)

    def with_image_text(
        self,
        system: str,
        user: str,
        image_path: str,
        temperature: float,
        max_tokens: int | None = None,
    ) -> ModelReply:
        return self._chat(
            self._image_messages(system, user, image_path),
            temperature,
            json_mode=False,
            max_tokens=max_tokens,
        )

    def text(
        self,
        system: str,
        user: str,
        temperature: float,
        max_tokens: int | None = None,
    ) -> ModelReply:
        return self._chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature,
            max_tokens=max_tokens,
        )

    def unload(self) -> None:
        """Autoscaling owns remote residency; there is no local GPU to release."""

    close = unload
