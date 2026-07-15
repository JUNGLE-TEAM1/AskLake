"""Deterministic primitives shared by RAG staging, chunking, and indexing.

The module deliberately has no HTTP, Spark, or OpenSearch dependency.  Every
function is deterministic for the same Catalog schema, source row, and policy
version so a retry cannot silently produce a different document identity.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Iterable, Sequence


CHUNKING_STRATEGY = "semantic_embedding_llm"
CHUNKING_VERSION = "rag-chunk-v3"
EMBEDDING_INPUT_VERSION = "title_body_fields_v2"
FIELD_RENDERING_VERSION = "field_blocks_v1"
DEFAULT_TARGET_TOKENS = 800
DEFAULT_OVERLAP_TOKENS = 400
DEFAULT_MAX_TOKENS = 1_200
DEFAULT_AMBIGUITY_MARGIN = 0.05

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])(?:[\"'”’』」】)]*)\s+|\n{2,}")
_WORD_OR_CJK = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9_]+|[^\s]")


@dataclass(frozen=True)
class Sentence:
    index: int
    text: str
    start: int
    end: int
    token_count: int


@dataclass(frozen=True)
class ChunkSegment:
    start_sentence: int
    end_sentence: int
    token_count: int
    char_start: int
    char_end: int
    boundary_score: float | None = None
    ambiguous: bool = False


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def normalize_scalar(value: Any) -> Any:
    """Normalize values without changing their semantic type where possible."""

    if isinstance(value, str):
        return value.strip()
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return compact_json(value)


def flatten_value(value: Any, prefix: str = "") -> dict[str, Any]:
    """Flatten nested objects into deterministic dot-path fields.

    Arrays are retained as compact JSON because exploding them would create
    synthetic rows and violate the one source-row/one parent-document rule.
    """

    if isinstance(value, dict):
        flattened: dict[str, Any] = {}
        for key in sorted(value, key=lambda item: str(item)):
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            flattened.update(flatten_value(value[key], child_prefix))
        return flattened
    return {prefix: normalize_scalar(value)} if prefix else {}


def normalize_row(row: Any, schema_columns: Sequence[str]) -> dict[str, Any]:
    """Return only Catalog-declared columns in a stable flattened row."""

    if not isinstance(row, dict):
        return {}
    flattened = flatten_value(row)
    declared = {str(column) for column in schema_columns}
    normalized: dict[str, Any] = {}
    for column in schema_columns:
        name = str(column)
        if name in flattened:
            normalized[name] = flattened[name]
        elif name in row:
            normalized[name] = normalize_scalar(row[name])
    # Keep direct declared keys even if a source uses a non-string mapping key.
    for name, value in flattened.items():
        if name in declared and name not in normalized:
            normalized[name] = value
    return normalized


def estimate_tokens(text: str) -> int:
    """Model-independent conservative token estimate.

    The worker may use a provider with a tokenizer different from OpenAI's.
    Counting CJK characters, words, and punctuation separately avoids silently
    exceeding the configured chunk budget while keeping the core dependency-free.
    """

    if not text:
        return 0
    return len(_WORD_OR_CJK.findall(text))


def build_embedding_text(title: str | None, body: str) -> str:
    title_value = (title or "").strip()
    body_value = (body or "").strip()
    if title_value and body_value:
        return f"{title_value}\n\n{body_value}"
    return title_value or body_value


def render_field_section(blocks: Sequence[dict[str, Any]], section: str) -> tuple[str, list[dict[str, Any]]]:
    """Render ordered logical field blocks with deterministic source offsets."""

    section_name = str(section).upper()
    output = [f"[{section_name}]\n"]
    enriched: list[dict[str, Any]] = []
    cursor = len(output[0])
    emitted = 0
    for block in blocks:
        logical = str(block.get("logicalField") or block.get("logical_field") or "").strip()
        value = str(block.get("text") or "").strip()
        if not logical or not value:
            continue
        if emitted:
            output.append("\n\n")
            cursor += 2
        prefix = f"{logical}: "
        block_start = cursor
        output.append(prefix)
        cursor += len(prefix)
        value_start = cursor
        output.append(value)
        cursor += len(value)
        enriched.append({**block, "start": block_start, "end": cursor, "valueStart": value_start, "valueEnd": cursor})
        emitted += 1
    if not enriched:
        return "", []
    output.append(f"\n[/{section_name}]")
    return "".join(output), enriched


def render_field_section_range(blocks: Sequence[dict[str, Any]], section: str, start: int, end: int) -> tuple[str, list[dict[str, Any]]]:
    """Render only the field fragments covered by a canonical body range.

    Labels are repeated for every chunk, including when one field spans several
    chunks.  Offsets remain offsets in the complete canonical section.
    """

    fragments: list[dict[str, Any]] = []
    for block in blocks:
        value_start = int(block.get("valueStart", block.get("start", 0)))
        value_end = int(block.get("valueEnd", block.get("end", 0)))
        overlap_start = max(start, value_start)
        overlap_end = min(end, value_end)
        if overlap_start >= overlap_end:
            continue
        text = str(block.get("text") or "")
        local_start = max(0, overlap_start - value_start)
        local_end = min(len(text), overlap_end - value_start)
        fragments.append({**block, "text": text[local_start:local_end], "fragmentStart": overlap_start, "fragmentEnd": overlap_end})
    return render_field_section(fragments, section)


def split_sentences(text: str) -> list[Sentence]:
    normalized = (text or "").strip()
    if not normalized:
        return []
    sentences: list[Sentence] = []
    cursor = 0
    for match in _SENTENCE_SPLIT.finditer(normalized):
        end = match.start()
        value = normalized[cursor:end].strip()
        if value:
            start = normalized.find(value, cursor, end)
            sentences.append(Sentence(len(sentences), value, start, start + len(value), estimate_tokens(value)))
        cursor = match.end()
    value = normalized[cursor:].strip()
    if value:
        start = normalized.find(value, cursor)
        sentences.append(Sentence(len(sentences), value, start, start + len(value), estimate_tokens(value)))
    return sentences


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


def _cumulative_tokens(sentences: Sequence[Sentence]) -> list[int]:
    totals = [0]
    for sentence in sentences:
        totals.append(totals[-1] + sentence.token_count)
    return totals


def _overlap_start(sentences: Sequence[Sentence], end: int, overlap_tokens: int) -> int:
    total = 0
    start = end
    while start > 0 and total < overlap_tokens:
        start -= 1
        total += sentences[start].token_count
    return start


def build_embedding_boundary_candidates(
    sentences: Sequence[Sentence],
    vectors: Sequence[Sequence[float]] | None = None,
    *,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    ambiguity_margin: float = DEFAULT_AMBIGUITY_MARGIN,
) -> list[ChunkSegment]:
    """Build deterministic candidate chunks from sentence vectors.

    The candidate generator never drops or rewrites a sentence.  LLM
    refinement receives these candidates later and may only move boundaries.
    """

    if not sentences:
        return []
    totals = _cumulative_tokens(sentences)
    if totals[-1] <= target_tokens:
        return [ChunkSegment(0, len(sentences), totals[-1], sentences[0].start, sentences[-1].end)]

    scores: dict[int, float] = {}
    for boundary in range(1, len(sentences)):
        scores[boundary] = 1.0 - cosine_similarity(vectors[boundary - 1], vectors[boundary]) if vectors and len(vectors) == len(sentences) else 0.0

    segments: list[ChunkSegment] = []
    start = 0
    while start < len(sentences):
        candidates: list[int] = []
        if totals[-1] - totals[start] <= max_tokens:
            end = len(sentences)
            candidates = [end]
        else:
            lower = min(totals[-1], totals[start] + max(1, target_tokens - overlap_tokens // 2))
            upper = min(totals[-1], totals[start] + max_tokens)
            candidates = [index for index in range(start + 1, len(sentences) + 1) if lower <= totals[index] <= upper]
            if not candidates:
                candidates = [index for index in range(start + 1, len(sentences) + 1) if totals[index] <= upper]
            if not candidates:
                candidates = [min(start + 1, len(sentences))]
            end = max(candidates, key=lambda index: (scores.get(index, 0.0), -abs((totals[index] - totals[start]) - target_tokens)))
        boundary_score = scores.get(end)
        nearby = sorted((scores.get(index, 0.0) for index in candidates), reverse=True)
        ambiguous = bool(vectors) and len(nearby) > 1 and nearby[0] - nearby[1] < ambiguity_margin
        segments.append(ChunkSegment(start, end, totals[end] - totals[start], sentences[start].start, sentences[end - 1].end, boundary_score, ambiguous))
        if end >= len(sentences):
            break
        next_start = _overlap_start(sentences, end, overlap_tokens)
        start = max(start + 1, next_start)
    return segments


def parent_document_id(dataset_id: str, source_row_id: str, normalized_row: dict[str, Any]) -> str:
    row_hash = hashlib.sha256(compact_json(normalized_row).encode("utf-8")).hexdigest()
    return hashlib.sha256(f"{dataset_id}:{source_row_id}:{row_hash}".encode("utf-8")).hexdigest()[:32]


def chunk_document_id(parent_id: str, chunk_index: int, embedding_text: str, metadata: dict[str, Any]) -> str:
    # Child identity is derived from the final embedding input only. Metadata
    # is a filter/display concern and must not change the chunk identity.
    content_hash = hashlib.sha256(embedding_text.encode("utf-8")).hexdigest()
    return hashlib.sha256(f"{parent_id}:{chunk_index}:{content_hash}".encode("utf-8")).hexdigest()[:32]


def unique_preserving_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result
