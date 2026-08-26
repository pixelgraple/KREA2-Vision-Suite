from __future__ import annotations

import json
import re
from typing import get_origin

from pydantic import BaseModel, ValidationError
from pydantic_core import PydanticUndefined


SCHEMA_MARKERS = {"$defs", "$schema", "properties", "required", "title", "type"}


def extract(raw: str) -> str:
    raw = re.sub(
        r"^\s*```(?:json)?\s*|\s*```\s*$",
        "",
        raw.strip(),
        flags=re.I | re.S,
    )
    first, last = raw.find("{"), raw.rfind("}")
    return raw[first : last + 1] if first >= 0 and last > first else raw


def _empty_value(annotation):
    origin = get_origin(annotation)
    if annotation is str:
        return ""
    if annotation is int:
        return 0
    if annotation is float:
        return 0.0
    if annotation is bool:
        return False
    if origin is list:
        return []
    if origin is dict:
        return {}
    return None


def instance_dict(model_type: type[BaseModel]) -> dict:
    result = {}
    for name, field in model_type.model_fields.items():
        default = field.get_default(call_default_factory=True)
        result[name] = (
            _empty_value(field.annotation)
            if default is PydanticUndefined
            else default
        )
    return result


def instance_template(model_type: type[BaseModel]) -> str:
    return json.dumps(instance_dict(model_type), ensure_ascii=False)


def looks_like_schema(raw: str, model_type: type[BaseModel]) -> bool:
    try:
        payload = json.loads(extract(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False
    expected = set(model_type.model_fields)
    return bool(SCHEMA_MARKERS.intersection(payload)) and not expected.issubset(payload)


def _json_string_field(raw: str, key: str, *, allow_truncated: bool = False) -> str | None:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"',raw)
    if not match:
        return None
    start=match.end()
    escaped=False
    for index in range(start,len(raw)):
        char=raw[index]
        if escaped:
            escaped=False
            continue
        if char=="\\":
            escaped=True
            continue
        if char=='"':
            fragment=raw[start:index]
            try:
                return json.loads('"'+fragment+'"')
            except json.JSONDecodeError:
                return None
    if not allow_truncated:
        return None
    fragment=raw[start:].replace("\r"," ").replace("\n"," ").rstrip()
    for _ in range(min(16,len(fragment))+1):
        try:
            return json.loads('"'+fragment+'"')
        except json.JSONDecodeError:
            fragment=fragment[:-1]
    return None


def _salvage_truncated_prompt(raw: str, model_type: type[BaseModel]) -> BaseModel | None:
    if set(model_type.model_fields)!={"final_prompt","negative_prompt","sections"}:
        return None
    if any(marker in raw for marker in ('"properties"','"$schema"','"$defs"')):
        return None
    final_prompt=_json_string_field(raw,"final_prompt")
    if final_prompt is None or not final_prompt.strip():
        return None
    negative_prompt=_json_string_field(raw,"negative_prompt")
    if negative_prompt is None:
        negative_prompt=_json_string_field(raw,"negative_prompt",allow_truncated=True) or ""
    return model_type.model_validate({
        "final_prompt":final_prompt,
        "negative_prompt":negative_prompt,
        "sections":{},
    })


def _validated_instance(raw: str, model_type: type[BaseModel]) -> BaseModel:
    payload = json.loads(extract(raw))
    if not isinstance(payload, dict):
        raise ValueError("structured output is not a JSON object")

    expected = set(model_type.model_fields)
    missing = expected.difference(payload)
    if missing:
        if SCHEMA_MARKERS.intersection(payload):
            raise ValueError("model returned a JSON schema instead of a populated instance")
        raise ValueError(f"structured output is missing fields: {sorted(missing)}")
    return model_type.model_validate(payload)


def parse_or_repair(reply, model_type: type[BaseModel], provider, temperature: float):
    try:
        return _validated_instance(reply.text, model_type)
    except (json.JSONDecodeError, TypeError, ValueError, ValidationError):
        salvaged=_salvage_truncated_prompt(reply.text,model_type)
        if salvaged is not None:
            return salvaged
        template = instance_template(model_type)
        repair = provider.text(
            "Return one populated JSON object only. Never return a JSON schema, add facts, or add prose.",
            "Repair the broken response into a populated JSON instance with every key in "
            f"this template: {template}\nPreserve only facts already present in the broken "
            f"response; use empty values where evidence is absent.\nBroken response: {reply.text}",
            temperature,
        )
        try:
            return _validated_instance(repair.text, model_type)
        except (json.JSONDecodeError, TypeError, ValueError, ValidationError) as exc:
            salvaged=_salvage_truncated_prompt(repair.text,model_type)
            if salvaged is not None:
                return salvaged
            raise RuntimeError(
                "Qwen returned malformed or schema-only structured JSON after a strict "
                "repair attempt. Try Reinspect Image or a larger Qwen3-VL variant."
            ) from exc
