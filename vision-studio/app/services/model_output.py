from __future__ import annotations

import json
import re


_THINK_BLOCK_RE = re.compile(r"(?is)<think\b[^>]*>.*?</think\s*>")
_CHANNEL_VALUE_RE = re.compile(
    r"(?i)<\|?channel\|?>\s*(?:analysis|thought|final|assistant|message)\b"
)
_TRANSPORT_TOKEN_RE = re.compile(
    r"(?i)<\|?(?:channel|analysis|thought|final|assistant|message)\|?>"
)
_LEADING_CHANNEL_RE = re.compile(
    r"(?i)^\s*(?:analysis|thought|final|assistant)\s*(?=(?:```|\{))"
)
_FENCE_RE = re.compile(
    r"```(?:json|text|markdown)?\s*(.*?)\s*```",
    re.DOTALL | re.IGNORECASE,
)
_PROSE_KEYS = ("description", "evidence", "prompt", "content", "text", "answer", "response")


def unwrap_model_transport(raw: str) -> str:
    """Remove known llama.cpp/chat-template transport wrappers from model text."""

    candidate = str(raw or "").strip()
    candidate = _THINK_BLOCK_RE.sub("", candidate).strip()
    had_transport_token = bool(_TRANSPORT_TOKEN_RE.search(candidate))
    if had_transport_token:
        candidate = _CHANNEL_VALUE_RE.sub("", candidate).strip()
        candidate = _TRANSPORT_TOKEN_RE.sub("", candidate).strip()
        candidate = _LEADING_CHANNEL_RE.sub("", candidate, count=1).strip()

    full_fence = _FENCE_RE.fullmatch(candidate)
    if full_fence:
        return full_fence.group(1).strip()

    # Some llama.cpp chat templates place a channel marker before a fenced
    # answer. Only extract an embedded fence when that known marker existed,
    # so ordinary prose containing a code example remains untouched.
    if had_transport_token:
        fenced_blocks = _FENCE_RE.findall(candidate)
        for fenced in reversed(fenced_blocks):
            try:
                parsed = json.loads(fenced.strip())
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict) and (
                isinstance(parsed.get("prompt"), str)
                or (
                    isinstance(parsed.get("prompt_variants"), list)
                    and all(isinstance(item, str) for item in parsed["prompt_variants"])
                )
            ):
                return fenced.strip()

    return candidate


def unwrap_grounded_prose(raw: str) -> str:
    """Recover prose from harmless transport or one-field JSON wrappers."""

    candidate = unwrap_model_transport(raw)
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        pass
    else:
        if isinstance(parsed, dict):
            prose_values = [
                parsed[key].strip()
                for key in _PROSE_KEYS
                if isinstance(parsed.get(key), str) and parsed[key].strip()
            ]
            other_strings = [
                value
                for key, value in parsed.items()
                if key not in _PROSE_KEYS and isinstance(value, str) and value.strip()
            ]
            if len(prose_values) == 1 and not other_strings:
                candidate = prose_values[0]

    return re.sub(
        r"(?is)^\s*(?:#{1,6}\s*)?(?:\*\*)?"
        r"(?:visual\s+)?(?:description|evidence|answer|response)(?:\*\*)?\s*:\s*",
        "",
        candidate,
        count=1,
    ).strip()


def recover_prompt_value(raw: str) -> str:
    """Recover a prompt value from a previously saved wrapped model answer."""

    original = str(raw or "").strip()
    candidate = unwrap_model_transport(original)
    if candidate == original:
        return original
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return candidate
    if isinstance(parsed, dict) and set(parsed) == {"prompt"} and isinstance(parsed["prompt"], str):
        return parsed["prompt"].strip()
    return candidate
