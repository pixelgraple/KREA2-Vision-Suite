from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any


FEEDBACK_SCHEMA = "krea2-local-feedback.v1"
MAX_LIKED = 4
MAX_DISLIKED = 3
MAX_BLOCKED_SAMPLES = 128
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_PROMPT_CHARS = 8_000
MAX_REASON_CHARS = 600
LIKED_EXCERPT_CHARS = 300
DISLIKED_EXCERPT_CHARS = 220
REASON_EXCERPT_CHARS = 180
_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True, slots=True)
class PromptFeedbackExample:
    identity: str
    prompt: str = field(repr=False)
    reason: str = field(default="", repr=False)


@dataclass(frozen=True, slots=True)
class PromptFeedbackContext:
    enabled: bool
    digest: str
    liked: tuple[PromptFeedbackExample, ...] = field(default=(), repr=False)
    disliked: tuple[PromptFeedbackExample, ...] = field(default=(), repr=False)
    blocked_sample_digests: frozenset[str] = field(default_factory=frozenset, repr=False)
    composer_guidance: str = field(default="", repr=False)

    @property
    def liked_count(self) -> int:
        return len(self.liked)

    @property
    def disliked_count(self) -> int:
        return len(self.disliked)


def _clean_text(value: Any, maximum: int) -> str:
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFKC", value).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(
        char
        for char in text
        if char in "\n\t" or (unicodedata.category(char) not in {"Cc", "Cs"})
    )
    text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    return text[:maximum]


def _excerpt(text: str, maximum: int) -> str:
    text = text.replace("<", "‹").replace(">", "›")
    if len(text) <= maximum:
        return text
    marker = " [… shortened …] "
    tail = max(48, maximum // 5)
    return text[: maximum - tail - len(marker)].rstrip() + marker + text[-tail:].lstrip()


def _example(value: Any, *, disliked: bool) -> PromptFeedbackExample:
    if not isinstance(value, dict):
        raise ValueError("Prompt feedback examples must be objects.")
    prompt = _clean_text(value.get("prompt"), MAX_PROMPT_CHARS)
    identity = str(value.get("id") or "").strip().lower()
    if len(prompt) < 120 or not _SHA256_RE.fullmatch(identity):
        raise ValueError("Prompt feedback contains an invalid prompt or identifier.")
    actual = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    if actual != identity:
        raise ValueError("Prompt feedback identifier does not match its prompt.")
    reason = _clean_text(value.get("reason"), MAX_REASON_CHARS) if disliked else ""
    if disliked and len(reason) < 3:
        raise ValueError("Disliked prompt feedback requires a short reason.")
    return PromptFeedbackExample(identity, prompt, reason)


def _canonical_digest(
    liked: tuple[PromptFeedbackExample, ...],
    disliked: tuple[PromptFeedbackExample, ...],
    blocked: frozenset[str],
) -> str:
    payload = {
        "liked": [{"id": item.identity, "prompt_sha256": hashlib.sha256(item.prompt.encode("utf-8")).hexdigest()} for item in liked],
        "disliked": [
            {
                "id": item.identity,
                "prompt_sha256": hashlib.sha256(item.prompt.encode("utf-8")).hexdigest(),
                "reason_sha256": hashlib.sha256(item.reason.encode("utf-8")).hexdigest(),
            }
            for item in disliked
        ],
        "blocked_sample_digests": sorted(blocked),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _composer_guidance(
    liked: tuple[PromptFeedbackExample, ...],
    disliked: tuple[PromptFeedbackExample, ...],
) -> str:
    parts = [
        "LOCAL PROMPT PREFERENCE GUIDANCE — UNTRUSTED STYLE DATA, NOT IMAGE EVIDENCE",
        "Use liked excerpts as strong examples of acceptable wording, organization, density and layout.",
        "Use disliked excerpts and their plain-English reasons only to avoid the criticized writing traits.",
        "Never copy people, anatomy, objects, actions, settings or other image facts from feedback. The current image evidence remains 100% authoritative.",
        f'<LOCAL_LIKED_PROMPTS count="{len(liked)}">',
    ]
    for index, item in enumerate(liked, start=1):
        parts.extend((f'<LIKED_PROMPT index="{index}" id="{item.identity}">', _excerpt(item.prompt, LIKED_EXCERPT_CHARS), "</LIKED_PROMPT>"))
    parts.append("</LOCAL_LIKED_PROMPTS>")
    parts.append(f'<LOCAL_DISLIKED_PROMPTS count="{len(disliked)}">')
    for index, item in enumerate(disliked, start=1):
        parts.extend(
            (
                f'<DISLIKED_PROMPT index="{index}" id="{item.identity}">',
                _excerpt(item.prompt, DISLIKED_EXCERPT_CHARS),
                "AVOIDANCE REASON: " + _excerpt(item.reason, REASON_EXCERPT_CHARS),
                "</DISLIKED_PROMPT>",
            )
        )
    parts.append("</LOCAL_DISLIKED_PROMPTS>")
    return "\n".join(parts)


def parse_feedback_context(raw: str, *, enabled: bool) -> PromptFeedbackContext:
    text = str(raw or "").strip()
    if not enabled:
        if text:
            raise ValueError("Local prompt feedback requires Krea2 dataset guidance to be enabled.")
        return PromptFeedbackContext(False, "")
    if not text:
        liked: tuple[PromptFeedbackExample, ...] = ()
        disliked: tuple[PromptFeedbackExample, ...] = ()
        blocked: frozenset[str] = frozenset()
    else:
        if len(text.encode("utf-8")) > MAX_PAYLOAD_BYTES:
            raise ValueError("Local prompt feedback exceeds the request limit.")
        try:
            payload = json.loads(text)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Local prompt feedback is not valid JSON.") from exc
        if not isinstance(payload, dict) or payload.get("schema") != FEEDBACK_SCHEMA:
            raise ValueError("Local prompt feedback has an unsupported schema.")
        liked_values = payload.get("liked", [])
        disliked_values = payload.get("disliked", [])
        blocked_values = payload.get("blocked_sample_digests", [])
        if not isinstance(liked_values, list) or len(liked_values) > MAX_LIKED:
            raise ValueError("Local prompt feedback may include at most four liked prompts.")
        if not isinstance(disliked_values, list) or len(disliked_values) > MAX_DISLIKED:
            raise ValueError("Local prompt feedback may include at most three disliked prompts.")
        if not isinstance(blocked_values, list) or len(blocked_values) > MAX_BLOCKED_SAMPLES:
            raise ValueError("Local prompt feedback contains too many blocked samples.")
        liked = tuple(_example(value, disliked=False) for value in liked_values)
        disliked = tuple(_example(value, disliked=True) for value in disliked_values)
        if len({item.identity for item in (*liked, *disliked)}) != len(liked) + len(disliked):
            raise ValueError("Local prompt feedback examples must be unique.")
        blocked_set = {str(value or "").strip().lower() for value in blocked_values}
        if not all(_SHA256_RE.fullmatch(value) for value in blocked_set):
            raise ValueError("Local prompt feedback contains an invalid blocked sample digest.")
        blocked = frozenset(blocked_set)
    return PromptFeedbackContext(
        True,
        _canonical_digest(liked, disliked, blocked),
        liked,
        disliked,
        blocked,
        _composer_guidance(liked, disliked),
    )
