from __future__ import annotations

import hashlib
import json
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

import requests


CONTRIBUTION_ENDPOINT = "https://seedframe.xyz/api/training/krea2-contributions"
CONTRIBUTION_SCHEMA = "seedframe.krea2-vision-contribution.v1"
CONTRIBUTION_TERMS_VERSION = "seedframe-krea2-vision-2026-08-25"
CONTRIBUTION_USER_AGENT = "Krea2VisionBackend/1.0"


class Krea2ContributionError(RuntimeError):
    """The online dataset did not durably accept a disclosed prompt contribution."""


def _normalize_prompt(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join(normalized.split())


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_batch(model_id: str, pipeline_id: str, prompts: list[str]) -> str:
    return _canonical_contribution(CONTRIBUTION_SCHEMA, model_id, pipeline_id, prompts)


def _canonical_contribution(
    schema: str,
    model_id: str,
    pipeline_id: str,
    prompts: list[str],
) -> str:
    return json.dumps(
        [
            schema,
            CONTRIBUTION_TERMS_VERSION,
            model_id,
            pipeline_id,
            *prompts,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


@dataclass(frozen=True)
class ContributionReceipt:
    batch_sha256: str
    dataset_revision: int
    duplicate: bool


class Krea2PromptContributor:
    """Send prompt text only to Seedframe with bounded, memory-only retries."""

    def __init__(
        self,
        vision_token: str,
        *,
        endpoint: str = CONTRIBUTION_ENDPOINT,
        http: Any = requests,
        timeout_seconds: float = 12.0,
        attempts: int = 3,
    ):
        token = str(vision_token or "")
        if len(token.encode("utf-8")) < 32:
            raise ValueError("A configured Vision token is required for anonymous contribution provenance.")
        if endpoint != CONTRIBUTION_ENDPOINT:
            raise ValueError("Krea2 contributions are restricted to the canonical Seedframe endpoint.")
        self.endpoint = endpoint
        self.http = http
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 30.0))
        self.attempts = max(1, min(int(attempts), 3))
        self.source_instance_sha256 = hashlib.sha256(
            b"Krea2VisionContributionSource/v1\0" + token.encode("utf-8")
        ).hexdigest()

    def _submit_payload(
        self,
        *,
        schema: str,
        batch_sha256: str,
        payload: dict[str, Any],
        accepted_count: int,
    ) -> ContributionReceipt:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": CONTRIBUTION_USER_AGENT,
            "X-Krea2-Contribution-Contract": schema,
            "X-Krea2-Terms-Version": CONTRIBUTION_TERMS_VERSION,
        }

        last_error = "Online Krea2 dataset contribution failed."
        for attempt in range(self.attempts):
            try:
                response = self.http.post(
                    self.endpoint,
                    data=body,
                    headers=headers,
                    timeout=self.timeout_seconds,
                    allow_redirects=False,
                )
                if response.status_code != 200:
                    last_error = f"Seedframe contribution returned HTTP {response.status_code}."
                    if response.status_code != 429 and response.status_code < 500:
                        break
                else:
                    receipt = response.json()
                    if (
                        isinstance(receipt, dict)
                        and receipt.get("accepted") is True
                        and receipt.get("batch_sha256") == batch_sha256
                        and int(receipt.get("accepted_count") or 0) == accepted_count
                        and receipt.get("rights_status") == "review_required"
                        and receipt.get("training_ready") is False
                    ):
                        return ContributionReceipt(
                            batch_sha256=batch_sha256,
                            dataset_revision=max(0, int(receipt.get("dataset_revision") or 0)),
                            duplicate=receipt.get("duplicate") is True,
                        )
                    last_error = "Seedframe returned an invalid contribution receipt."
            except (requests.RequestException, ValueError, TypeError, json.JSONDecodeError) as exc:
                last_error = f"Seedframe contribution transport failed ({type(exc).__name__})."
            if attempt + 1 < self.attempts:
                time.sleep(0.25 * (attempt + 1))
        raise Krea2ContributionError(last_error)

    def submit(self, result: Any) -> ContributionReceipt:
        prompts = [_normalize_prompt(str(item)) for item in list(result.prompt_variants)]
        if len(prompts) != 3 or len(set(prompts)) != 3 or any(not item for item in prompts):
            raise Krea2ContributionError("The generated prompt set does not contain three distinct variants.")
        model_id = unicodedata.normalize("NFKC", str(result.model or "")).strip()
        pipeline_id = unicodedata.normalize("NFKC", str(result.pipeline_id or "")).strip()
        if not model_id or not pipeline_id or len(model_id) > 200 or len(pipeline_id) > 200:
            raise Krea2ContributionError("The generated prompt provenance is invalid.")
        batch_sha256 = _sha256_text(_canonical_batch(model_id, pipeline_id, prompts))
        payload = {
            "schema": CONTRIBUTION_SCHEMA,
            "terms_version": CONTRIBUTION_TERMS_VERSION,
            "terms_accepted": True,
            "source_instance_sha256": self.source_instance_sha256,
            "batch_sha256": batch_sha256,
            "model_id": model_id,
            "pipeline_id": pipeline_id,
            "prompt_variants": prompts,
        }
        return self._submit_payload(
            schema=CONTRIBUTION_SCHEMA,
            batch_sha256=batch_sha256,
            payload=payload,
            accepted_count=3,
        )
