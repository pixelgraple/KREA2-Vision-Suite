from __future__ import annotations

import base64
import ipaddress
import re
import socket
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection

from .remote_access import RemoteAccess
from .vision_provider import ModelReply, VisionProvider


class RemoteGatewayProviderError(RuntimeError):
    pass


class _PinnedTlsOriginAdapter(HTTPAdapter):
    """Connect to one origin IP while verifying the public TLS hostname."""

    def __init__(self, origin_ip: str, tls_hostname: str):
        self.origin_ip = origin_ip
        self.tls_hostname = tls_hostname
        super().__init__()

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        pool_kwargs["assert_hostname"] = self.tls_hostname
        pool_kwargs["server_hostname"] = self.tls_hostname
        # Cold Vast workers can leave this TLS connection idle for several
        # minutes before the first response byte.  Keep the direct-origin TCP
        # path alive so a router/NAT does not reap a healthy request while the
        # remote GPU is still starting.
        socket_options = list(HTTPConnection.default_socket_options)
        socket_options.append((socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1))
        for option_name, value in (
            ("TCP_KEEPIDLE", 30),
            ("TCP_KEEPINTVL", 15),
            ("TCP_KEEPCNT", 4),
        ):
            option = getattr(socket, option_name, None)
            if option is not None:
                socket_options.append((socket.IPPROTO_TCP, option, value))
        pool_kwargs["socket_options"] = socket_options
        return super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)

    def send(self, request, **kwargs):
        parsed = urlsplit(request.url)
        host = f"[{self.origin_ip}]" if ":" in self.origin_ip else self.origin_ip
        port = f":{parsed.port}" if parsed.port else ""
        request.url = urlunsplit(
            (parsed.scheme, f"{host}{port}", parsed.path, parsed.query, parsed.fragment)
        )
        request.headers["Host"] = self.tls_hostname
        return super().send(request, **kwargs)


def fetch_remote_gateway_health(
    base_url: str,
    *,
    origin_ip: str = "",
    http: Any = requests,
) -> dict[str, Any]:
    """Read the gateway's public, secret-free capacity state."""

    normalized_url = str(base_url or "").strip().rstrip("/")
    parsed = urlsplit(normalized_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RemoteGatewayProviderError("Remote Vision gateway URL is invalid.")
    client = http
    if origin_ip:
        try:
            normalized_origin_ip = str(ipaddress.ip_address(origin_ip))
        except ValueError as exc:
            raise RemoteGatewayProviderError("Remote Vision origin IP is invalid.") from exc
        direct = requests.Session()
        direct.trust_env = False
        mount_prefix = f"https://{parsed.hostname}"
        if parsed.port:
            mount_prefix += f":{parsed.port}"
        direct.mount(
            mount_prefix + "/",
            _PinnedTlsOriginAdapter(normalized_origin_ip, parsed.hostname),
        )
        client = direct
    try:
        response = client.get(f"{normalized_url}/health", timeout=12)
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RemoteGatewayProviderError("Remote Vision capacity could not be verified.") from exc
    if response.status_code >= 400 or not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RemoteGatewayProviderError("Remote Vision capacity could not be verified.")
    return payload


class RemoteGatewayErrorReporter:
    """Send redacted technical failures to the gateway-owned Discord webhook."""

    def __init__(self, *, base_url: str, origin_ip: str = "", http: Any = requests):
        self.base_url = str(base_url or "").strip().rstrip("/")
        parsed = urlsplit(self.base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise RemoteGatewayProviderError("Remote Vision gateway URL is invalid.")
        self.http = http
        if origin_ip:
            try:
                normalized_origin_ip = str(ipaddress.ip_address(origin_ip))
            except ValueError as exc:
                raise RemoteGatewayProviderError("Remote Vision origin IP is invalid.") from exc
            direct = requests.Session()
            direct.trust_env = False
            mount_prefix = f"https://{parsed.hostname}"
            if parsed.port:
                mount_prefix += f":{parsed.port}"
            direct.mount(
                mount_prefix + "/",
                _PinnedTlsOriginAdapter(normalized_origin_ip, parsed.hostname),
            )
            self.http = direct

    def submit_safely(
        self,
        *,
        license_id: str,
        license_token: str,
        event_id: str,
        model_id: str,
        pipeline_id: str,
        error_code: str,
        error_message: str,
        stage: str,
        runtime: str,
        plugin_version: str,
        backend_version: str,
        technical_trace: str,
    ) -> bool:
        try:
            if not re.fullmatch(r"lic_[A-Za-z0-9_-]{12,64}", str(license_id or "")):
                return False
            if not 43 <= len(str(license_token or "")) <= 160:
                return False
            response = self.http.post(
                f"{self.base_url}/v1/audit/error",
                json={
                    "event_id": event_id,
                    "model_id": model_id,
                    "pipeline_id": pipeline_id,
                    "error_code": error_code,
                    "error_message": error_message,
                    "stage": stage,
                    "runtime": runtime,
                    "plugin_version": plugin_version,
                    "backend_version": backend_version,
                    "technical_trace": technical_trace,
                },
                headers={"Authorization": f"Krea2License {license_id}.{license_token}"},
                timeout=12,
                allow_redirects=False,
            )
            if response.status_code != 200:
                return False
            payload = response.json()
            return isinstance(payload, dict) and payload.get("accepted") is True
        except (requests.RequestException, ValueError, TypeError):
            return False


class RemoteGatewayProvider(VisionProvider):
    """OpenAI-compatible calls routed through the licensed KREA2 gateway."""

    # The gateway is responsible for admitting a request only when its worker
    # group is healthy.  Replaying a disconnected serverless request here made
    # a lost worker look like a very slow model call and doubled the wait for
    # the user.  Preserve one request/one accounting decision instead.
    TRANSIENT_ATTEMPTS = 1
    def __init__(self, *, base_url: str, model: str, max_tokens: int, timeout: float, access: RemoteAccess, origin_ip: str = "", http: Any = requests):
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
        if origin_ip:
            try:
                normalized_origin_ip = str(ipaddress.ip_address(origin_ip))
            except ValueError as exc:
                raise RemoteGatewayProviderError("Remote Vision origin IP is invalid.") from exc
            parsed = urlsplit(self.base_url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise RemoteGatewayProviderError("Remote Vision gateway URL is invalid.")
            # Route only this provider around the CDN timeout. The connection
            # still sends SNI for the public hostname and verifies that name on
            # the origin certificate; no system DNS or TLS checks are disabled.
            direct = requests.Session()
            direct.trust_env = False
            mount_prefix = f"https://{parsed.hostname}"
            if parsed.port:
                mount_prefix += f":{parsed.port}"
            direct.mount(
                mount_prefix + "/",
                _PinnedTlsOriginAdapter(normalized_origin_ip, parsed.hostname),
            )
            self.http = direct

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
        response = None
        body = None
        transport_error = None
        for attempt in range(self.TRANSIENT_ATTEMPTS):
            try:
                response = self.http.post(
                    f"{self.base_url}/v1/chat/completions",
                    json=payload,
                    headers=headers,
                    timeout=self.timeout + 15,
                )
            except requests.RequestException as exc:
                transport_error = exc
                raise RemoteGatewayProviderError(
                    "The remote Vision gateway could not be reached; your local GPU was not used."
                ) from exc
            try:
                body = response.json()
            except ValueError:
                body = None
            break
        if response is None:
            raise RemoteGatewayProviderError("The remote Vision gateway is unavailable.") from transport_error
        if response.status_code >= 400:
            detail = (
                str(body.get("detail") or "Remote Vision request failed.")
                if isinstance(body, dict)
                else f"Remote Vision gateway returned HTTP {response.status_code}."
            )
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

    def fail_audit(self) -> None:
        """Release the gateway's one-image reservation after a terminal pipeline failure."""
        headers = {"Authorization":self.access.authorization,"X-Krea2-Request-Id":self.access.request_id}
        try:
            response = self.http.post(f"{self.base_url}/v1/audit/fail", headers=headers, timeout=12)
            if response.status_code >= 400:
                raise RemoteGatewayProviderError("Remote audit refund failed.")
        except requests.RequestException:
            # The server's expiry sweep remains the backstop; retain the actual Vision error.
            return

    def unload(self) -> None:
        return

    close = unload
