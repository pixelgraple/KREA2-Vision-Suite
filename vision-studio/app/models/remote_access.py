from __future__ import annotations

from dataclasses import dataclass
import re


DISCORD_ID_RE = re.compile(r"^[1-9][0-9]{16,21}$")
LICENSE_ID_RE = re.compile(r"^lic_[A-Za-z0-9_-]{12,64}$")


@dataclass(frozen=True)
class RemoteAccess:
    license_id: str
    license_token: str
    request_id: str
    source_url: str = ""

    def validate(self) -> None:
        if not LICENSE_ID_RE.fullmatch(self.license_id):
            raise ValueError("Remote license ID is invalid.")
        if not 43 <= len(self.license_token) <= 160:
            raise ValueError("Remote license token is invalid.")
        if not re.fullmatch(r"[a-f0-9]{64}", self.request_id):
            raise ValueError("Remote Vision request ID is invalid.")

    @property
    def authorization(self) -> str:
        return f"Krea2License {self.license_id}.{self.license_token}"
