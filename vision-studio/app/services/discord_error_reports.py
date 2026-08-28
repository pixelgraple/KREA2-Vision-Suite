from __future__ import annotations

import re
import traceback
import unicodedata


MAX_TECHNICAL_TRACE = 128 * 1024
_CREDENTIAL_RE = re.compile(
    r"(?i)\b(?:token|secret|password|authorization|api[_ -]?key|license[_ -]?token)\s*[:=]\s*[^\s,;]+"
)
_AUTH_RE = re.compile(r"(?i)(?:Bearer|Krea2License)\s+[A-Za-z0-9._~+/=-]+")
_URL_RE = re.compile(r"https?://[^\s\]\[)>(\"']+")
_WINDOWS_USER_PATH_RE = re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\r\n]+")
_DATA_URL_RE = re.compile(r"data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+", re.I)
_CONTENT_FIELD_RE = re.compile(
    r"(?im)\b(?:prompt|prompt_text|model_output|response_content|image_bytes|image_data)\s*[:=]\s*[^\r\n]+"
)
_IMAGE_FILENAME_RE = re.compile(r"(?i)\b[^\s/\\]+\.(?:png|jpe?g|webp|gif|bmp|avif)\b")
_LONG_BLOB_RE = re.compile(r"\b[A-Za-z0-9+/=_-]{96,}\b")
_DISCORD_ID_RE = re.compile(r"\b[1-9][0-9]{16,21}\b")
_LICENSE_RE = re.compile(r"\blic_[A-Za-z0-9_-]{12,64}\b")


def redact_technical_trace(value: object, maximum: int = MAX_TECHNICAL_TRACE) -> str:
    """Keep useful stack frames while stripping user content and credentials."""

    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = _DATA_URL_RE.sub("[image data removed]", text)
    text = _CONTENT_FIELD_RE.sub("[generated content removed]", text)
    text = _AUTH_RE.sub("[authorization removed]", text)
    text = _CREDENTIAL_RE.sub("[credential removed]", text)
    text = _URL_RE.sub("[URL removed]", text)
    text = _WINDOWS_USER_PATH_RE.sub("[local path removed]", text)
    text = _IMAGE_FILENAME_RE.sub("[image filename removed]", text)
    text = _LICENSE_RE.sub("[license removed]", text)
    text = _DISCORD_ID_RE.sub("[Discord ID removed]", text)
    text = _LONG_BLOB_RE.sub("[opaque data removed]", text)
    text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    return (text or "No traceback was supplied.")[: max(1, min(int(maximum), MAX_TECHNICAL_TRACE))]


def exception_trace(error: BaseException) -> str:
    rendered = "".join(traceback.TracebackException.from_exception(error).format(chain=True))
    return redact_technical_trace(rendered)
