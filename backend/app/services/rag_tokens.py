"""Bounded token accounting shared by RAG retrieval and context assembly."""

from __future__ import annotations

import re

_TOKEN_RE = re.compile(r"[\uac00-\ud7a3]|[A-Za-z0-9_]+|[^\sA-Za-z0-9_\uac00-\ud7a3]", re.UNICODE)


def count_tokens(text: str) -> int:
    """Count model-like tokens without requiring a provider SDK.

    The fallback is deterministic and deliberately conservative for Korean,
    punctuation, and mixed-language content. A deployment may replace this
    function with the exact serving-model tokenizer without changing callers.
    """
    return len(_TOKEN_RE.findall(str(text or "")))


def truncate_tokens(text: str, limit: int) -> str:
    if limit <= 0:
        return ""
    matches = list(_TOKEN_RE.finditer(str(text or "")))
    if len(matches) <= limit:
        return str(text or "")
    end = matches[limit - 1].end()
    return str(text or "")[:end].rstrip()
