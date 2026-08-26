from __future__ import annotations

import base64
import ctypes
import ipaddress
import io
import os
import re
import secrets
import subprocess
import time
from pathlib import Path
from typing import Callable

import requests
from PIL import Image, ImageOps

from .vision_provider import ModelReply, VisionProvider


PUBLIC_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,159}$")


class LlamaCppProviderError(RuntimeError):
    pass


def _literal_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host


def _attach_kill_on_close_job(process) -> int | None:
    """Best-effort Windows Job Object containment for the exact server child."""

    if os.name != "nt":
        return None
    process_handle = getattr(process, "_handle", None)
    if not process_handle:
        return None
    try:
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        information.BasicLimitInformation.LimitFlags = 0x00002000
        configured = kernel32.SetInformationJobObject(
            job, 9, ctypes.byref(information), ctypes.sizeof(information)
        )
        assigned = configured and kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(job), wintypes.HANDLE(int(process_handle))
        )
        if not assigned:
            kernel32.CloseHandle(job)
            return None
        return int(job)
    except (AttributeError, OSError, TypeError, ValueError):
        return None


def _close_job(job_handle: int | None) -> None:
    if os.name != "nt" or not job_handle:
        return
    try:
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(wintypes.HANDLE(job_handle))
    except (AttributeError, OSError, TypeError, ValueError):
        pass


class LlamaCppProvider(VisionProvider):
    """One loopback llama-server child, owned for exactly one GPU queue lease."""

    def __init__(
        self,
        server_exe: str | Path,
        model_path: str | Path,
        mmproj_path: str | Path,
        alias: str,
        host: str = "127.0.0.1",
        port: int = 11435,
        context: int = 16384,
        max_tokens: int = 4096,
        startup_timeout: float = 180.0,
        api_key: str | None = None,
        telemetry_callback: Callable[[str, dict[str, object]], None] | None = None,
        runtime_log_path: str | Path | None = None,
        mmproj_offload: bool = True,
        image_min_tokens: int | None = None,
        image_max_tokens: int = 4096,
        image_max_side: int | None = None,
        gpu_layers: int | str = "all",
        fit_target_mb: int | None = None,
        *,
        http=None,
        popen_factory=None,
        sleeper: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.server_exe = Path(server_exe)
        self.model_path = Path(model_path)
        self.mmproj_path = Path(mmproj_path)
        self.alias = str(alias)
        self.host = str(host)
        self.port = int(port)
        self.context = int(context)
        self.max_tokens = int(max_tokens)
        self.startup_timeout = float(startup_timeout)
        self.api_key = api_key or secrets.token_urlsafe(32)
        self.telemetry_callback = telemetry_callback
        self.runtime_log_path = Path(runtime_log_path) if runtime_log_path else None
        self.mmproj_offload = bool(mmproj_offload)
        self.image_min_tokens = int(image_min_tokens) if image_min_tokens is not None else None
        self.image_max_tokens = int(image_max_tokens)
        self.image_max_side = int(image_max_side) if image_max_side is not None else None
        self.gpu_layers = gpu_layers
        self.fit_target_mb = int(fit_target_mb) if fit_target_mb is not None else None
        self.http = http or requests
        self._popen = popen_factory or subprocess.Popen
        self._sleep = sleeper
        self._monotonic = monotonic
        self._process = None
        self._job_handle: int | None = None
        self._unloaded = False

        self._validate()
        if self.runtime_log_path is not None:
            try:
                self.runtime_log_path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise LlamaCppProviderError("The local llama.cpp runtime log cannot be created.") from exc
        self.base_url = f"http://{_url_host(self.host)}:{self.port}"
        try:
            self._start()
            self._wait_until_ready()
            self._emit("ready")
        except BaseException as exc:
            try:
                self.unload()
            except Exception:
                pass
            if isinstance(exc, LlamaCppProviderError):
                raise
            raise LlamaCppProviderError("The local llama.cpp server could not start safely.") from exc

    def _validate(self) -> None:
        if not _literal_loopback(self.host):
            raise LlamaCppProviderError("llama.cpp must bind to a literal loopback IP.")
        if not 1 <= self.port <= 65535:
            raise LlamaCppProviderError("The llama.cpp port is invalid.")
        if not 512 <= self.context <= 262144:
            raise LlamaCppProviderError("The llama.cpp context limit is invalid.")
        if not 1 <= self.max_tokens < self.context:
            raise LlamaCppProviderError("The llama.cpp output limit must fit inside its context.")
        if not 1 <= self.image_max_tokens <= 16384:
            raise LlamaCppProviderError("The llama.cpp image token limit is invalid.")
        if self.image_min_tokens is not None and not 1 <= self.image_min_tokens <= self.image_max_tokens:
            raise LlamaCppProviderError("The llama.cpp minimum image token limit is invalid.")
        if self.image_max_side is not None and not 64 <= self.image_max_side <= 8192:
            raise LlamaCppProviderError("The llama.cpp image side limit is invalid.")
        if isinstance(self.gpu_layers, bool) or not (
            self.gpu_layers in {"all", "auto"}
            or isinstance(self.gpu_layers, int) and 0 <= self.gpu_layers <= 10000
        ):
            raise LlamaCppProviderError("The llama.cpp GPU layer limit is invalid.")
        if self.fit_target_mb is not None and not 256 <= self.fit_target_mb <= 262144:
            raise LlamaCppProviderError("The llama.cpp adaptive-fit target is invalid.")
        if not 0 < self.startup_timeout <= 1800:
            raise LlamaCppProviderError("The llama.cpp startup timeout is invalid.")
        if not PUBLIC_MODEL_ID.fullmatch(self.alias):
            raise LlamaCppProviderError("The llama.cpp public model ID is invalid.")
        if len(self.api_key.encode("utf-8")) < 24:
            raise LlamaCppProviderError("The llama.cpp loopback API key is too short.")
        if not self.server_exe.is_file():
            raise LlamaCppProviderError("The configured llama.cpp server executable is unavailable.")
        if not self.model_path.is_file() or not self.mmproj_path.is_file():
            raise LlamaCppProviderError("The configured llama.cpp model files are unavailable.")

    def _command(self) -> list[str]:
        command = [
            str(self.server_exe),
            "--model",
            str(self.model_path),
            "--mmproj",
            str(self.mmproj_path),
            "--alias",
            self.alias,
            "--host",
            self.host,
            "--port",
            str(self.port),
            "--ctx-size",
            str(self.context),
            "--parallel",
            "1",
            "--flash-attn",
            "on",
            "--cache-ram",
            "0",
            "--image-max-tokens",
            str(self.image_max_tokens),
            "--reasoning",
            "off",
            "--reasoning-format",
            "none",
            "--reasoning-budget",
            "0",
            "--api-key",
            self.api_key,
        ]
        if self.gpu_layers != "auto":
            command.extend(["--n-gpu-layers", str(self.gpu_layers)])
        if self.fit_target_mb is not None:
            command.extend(
                [
                    "--fit",
                    "on",
                    "--fit-target",
                    str(self.fit_target_mb),
                    "--fit-ctx",
                    str(self.context),
                ]
            )
        if self.image_min_tokens is not None:
            command.extend(["--image-min-tokens", str(self.image_min_tokens)])
        command.append("--mmproj-offload" if self.mmproj_offload else "--no-mmproj-offload")
        if self.runtime_log_path is not None:
            command.extend(
                [
                    "--log-file",
                    str(self.runtime_log_path),
                    "--log-timestamps",
                ]
            )
        return command

    def _start(self) -> None:
        self._emit("starting")
        self._process = self._popen(
            self._command(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
        self._job_handle = _attach_kill_on_close_job(self._process)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    def _wait_until_ready(self) -> None:
        deadline = self._monotonic() + self.startup_timeout
        while self._monotonic() < deadline:
            if self._process is None or self._process.poll() is not None:
                raise LlamaCppProviderError("The local llama.cpp server exited during startup.")
            try:
                response = self.http.get(
                    f"{self.base_url}/health",
                    headers=self._headers(),
                    timeout=2,
                )
                if 200 <= int(response.status_code) < 300:
                    return
            except (requests.RequestException, AttributeError, TypeError, ValueError):
                pass
            self._sleep(0.2)
        raise LlamaCppProviderError("The local llama.cpp server did not become ready in time.")

    def _emit(self, event: str) -> None:
        if self.telemetry_callback is None:
            return
        try:
            self.telemetry_callback(event, {"model_id": self.alias})
        except Exception:
            pass

    def _ensure_running(self) -> None:
        if self._unloaded or self._process is None or self._process.poll() is not None:
            raise LlamaCppProviderError("The local llama.cpp server is not running.")

    def _chat(
        self,
        messages: list[dict],
        temperature: float,
        *,
        json_mode: bool = True,
        max_tokens: int | None = None,
    ) -> ModelReply:
        self._ensure_running()
        if max_tokens is None:
            output_limit = self.max_tokens
        else:
            if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens < 1:
                raise LlamaCppProviderError("The llama.cpp per-request output limit is invalid.")
            output_limit = min(max_tokens, self.max_tokens)
        payload = {
            "model": self.alias,
            "messages": messages,
            "temperature": float(temperature),
            "max_tokens": output_limit,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        try:
            response = self.http.post(
                f"{self.base_url}/v1/chat/completions",
                headers=self._headers(),
                json=payload,
                timeout=900,
            )
            response.raise_for_status()
            data = response.json()
            message = data["choices"][0]["message"]
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                content = message.get("reasoning_content")
            if not isinstance(content, str):
                raise TypeError("response content was not text")
            usage = data.get("usage", {})
            return ModelReply(content, usage if isinstance(usage, dict) else {})
        except (requests.RequestException, KeyError, IndexError, TypeError, ValueError) as exc:
            raise LlamaCppProviderError("The local llama.cpp inference request failed.") from exc

    @staticmethod
    def _image_mime(image_path: str | Path) -> str:
        suffix = Path(image_path).suffix.casefold()
        return {
            ".png": "image/png",
            ".webp": "image/webp",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
        }.get(suffix, "image/jpeg")

    def _image_messages(self, system: str, user: str, image_path: str) -> list[dict]:
        try:
            if self.image_max_side is None:
                image_bytes = Path(image_path).read_bytes()
                mime = self._image_mime(image_path)
            else:
                with Image.open(image_path) as source:
                    normalized = ImageOps.exif_transpose(source).convert("RGB")
                    normalized.thumbnail(
                        (self.image_max_side, self.image_max_side),
                        Image.Resampling.LANCZOS,
                    )
                    buffer = io.BytesIO()
                    normalized.save(buffer, "JPEG", quality=95, optimize=True)
                    image_bytes = buffer.getvalue()
                    mime = "image/jpeg"
            encoded = base64.b64encode(image_bytes).decode("ascii")
        except (OSError, ValueError) as exc:
            raise LlamaCppProviderError("The validated image could not be read for local inference.") from exc
        data_uri = f"data:{mime};base64,{encoded}"
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

    def with_image(self, system: str, user: str, image_path: str, temperature: float) -> ModelReply:
        return self._chat(self._image_messages(system,user,image_path),temperature)

    def with_image_text(
        self,
        system: str,
        user: str,
        image_path: str,
        temperature: float,
        max_tokens: int | None = None,
    ) -> ModelReply:
        """Run grounded image inference without forcing JSON-object response mode."""
        return self._chat(
            self._image_messages(system,user,image_path),
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
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature,
            max_tokens=max_tokens,
        )

    def unload(self) -> None:
        if self._unloaded:
            return
        process = self._process
        self._emit("stopping")
        stopped = process is None or process.poll() is not None
        try:
            if process is not None and not stopped:
                try:
                    process.terminate()
                    process.wait(timeout=10)
                    stopped = True
                except (subprocess.TimeoutExpired, OSError):
                    try:
                        process.kill()
                        process.wait(timeout=10)
                        stopped = True
                    except (subprocess.TimeoutExpired, OSError):
                        stopped = process.poll() is not None
        finally:
            _close_job(self._job_handle)
            self._job_handle = None
            if process is not None and not stopped:
                try:
                    process.wait(timeout=5)
                    stopped = True
                except (subprocess.TimeoutExpired, OSError):
                    stopped = process.poll() is not None
        if not stopped:
            raise LlamaCppProviderError("The local llama.cpp server could not be stopped safely.")
        self._process = None
        self._unloaded = True
        self._emit("stopped")

    close = unload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.unload()
