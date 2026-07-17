"""Separate RAG chunking stage.

Chunking owns sentence-boundary decisions.  It may use sentence embeddings
and the AI Gateway boundary-only mode, but it never creates final document
embeddings or talks to OpenSearch.
"""

from __future__ import annotations

from typing import Any, Callable, Sequence
import hashlib

from .rag_core import (
    CHUNKING_STRATEGY,
    CHUNKING_VERSION,
    DEFAULT_MAX_TOKENS,
    DEFAULT_OVERLAP_TOKENS,
    DEFAULT_TARGET_TOKENS,
    EMBEDDING_INPUT_VERSION,
    FIELD_RENDERING_VERSION,
    ChunkSegment,
    build_embedding_boundary_candidates,
    build_embedding_text,
    chunk_document_id,
    estimate_tokens,
    render_field_section,
    render_field_section_range,
    _overlap_start,
    _WORD_OR_CJK,
    split_sentences,
)
from .errors import PermanentRagContractError


SentenceEmbedder = Callable[[list[str]], list[list[float]]]
BoundaryRefiner = Callable[[list[dict[str, Any]], list[int]], list[dict[str, int]]]


def _field_roles(field: dict[str, Any]) -> list[str]:
    raw_roles = field.get("roles")
    values = raw_roles if isinstance(raw_roles, list) else [field.get("role")]
    return list(
        dict.fromkeys(
            str(value).strip().casefold()
            for value in values
            if str(value or "").strip()
        )
    )


def _merge_source_fields(fields: Sequence[Any]) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for raw_field in fields:
        if not isinstance(raw_field, dict):
            continue
        logical = str(raw_field.get("logicalField") or "").strip()
        physical = str(raw_field.get("physicalField") or logical).strip()
        if not logical:
            continue
        roles = _field_roles(raw_field)
        key = (logical, physical)
        current = merged.get(key)
        if current is None:
            current = {
                **raw_field,
                "logicalField": logical,
                "physicalField": physical,
                "role": roles[0] if roles else str(raw_field.get("role") or ""),
                "roles": roles,
            }
            merged[key] = current
        else:
            current["roles"] = list(dict.fromkeys([*current.get("roles", []), *roles]))
            if not current.get("role") and current["roles"]:
                current["role"] = current["roles"][0]
    return list(merged.values())


def _valid_refined_segments(raw: Sequence[dict[str, Any]], sentence_count: int) -> list[ChunkSegment] | None:
    if not raw or sentence_count <= 0:
        return None
    segments: list[ChunkSegment] = []
    expected = 0
    for item in raw:
        try:
            start = int(item["startSentence"] if "startSentence" in item else item["start_sentence"])
            end = int(item["endSentence"] if "endSentence" in item else item["end_sentence"])
        except (KeyError, TypeError, ValueError):
            return None
        if start != expected or start < 0 or end < start or end >= sentence_count:
            return None
        segments.append(ChunkSegment(start, end + 1, 0, 0, 0, ambiguous=False))
        expected = end + 1
    return segments if expected == sentence_count else None


def _with_offsets(segments: Sequence[ChunkSegment], sentences: Sequence[Any]) -> list[ChunkSegment]:
    return [
        ChunkSegment(
            segment.start_sentence,
            segment.end_sentence,
            sum(sentences[index].token_count for index in range(segment.start_sentence, segment.end_sentence)),
            sentences[segment.start_sentence].start,
            sentences[segment.end_sentence - 1].end,
            segment.boundary_score,
            segment.ambiguous,
        )
        for segment in segments
    ]


def _apply_overlap(segments: Sequence[ChunkSegment], sentences: Sequence[Any], overlap_tokens: int) -> list[ChunkSegment]:
    """Apply the configured overlap after LLM returns logical boundaries."""
    result: list[ChunkSegment] = []
    for index, segment in enumerate(segments):
        start = segment.start_sentence if index == 0 else max(0, _overlap_start(sentences, segment.start_sentence, overlap_tokens))
        result.append(ChunkSegment(start, segment.end_sentence, 0, 0, 0, segment.boundary_score, segment.ambiguous))
    return _with_offsets(result, sentences)


def _split_long_sentence(sentence: Any, *, max_tokens: int, overlap_tokens: int) -> list[Any]:
    """Split log/OCR/code-like sentences that have no punctuation boundary."""
    if sentence.token_count <= max_tokens:
        return [sentence]
    matches = list(_WORD_OR_CJK.finditer(sentence.text))
    if not matches:
        return [sentence]
    result = []
    start_token = 0
    while start_token < len(matches):
        end_token = min(len(matches), start_token + max_tokens)
        local_start = matches[start_token].start()
        local_end = matches[end_token - 1].end()
        text = sentence.text[local_start:local_end].strip()
        result.append(type(sentence)(len(result), text, sentence.start + local_start, sentence.start + local_end, estimate_tokens(text)))
        if end_token >= len(matches):
            break
        start_token = max(start_token + 1, end_token - overlap_tokens)
    return result


def _field_section_overhead(blocks: Sequence[dict[str, Any]], section: str) -> int:
    labels = [f"{str(block.get('logicalField') or '').strip()}: " for block in blocks if str(block.get('logicalField') or '').strip()]
    if not labels:
        return 0
    return estimate_tokens(f"[{section}]\n" + "\n\n".join(labels) + f"\n[/{section}]")


def chunk_parent_document(
    parent: dict[str, Any],
    *,
    embed_sentences: SentenceEmbedder,
    refine_boundaries: BoundaryRefiner,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[dict[str, Any]]:
    raw_body_blocks = parent.get("body_blocks")
    if not isinstance(raw_body_blocks, list):
        raw_body_blocks = []
    body_blocks = [block for block in raw_body_blocks if isinstance(block, dict)]
    if not body_blocks:
        legacy_body = str(parent.get("body") or "").strip()
        if legacy_body:
            body_blocks = [{"logicalField": "body", "physicalField": "body", "text": legacy_body}]
    body, canonical_body_blocks = render_field_section(body_blocks, "BODY")
    raw_title_blocks = parent.get("title_blocks")
    title_blocks = [block for block in raw_title_blocks if isinstance(block, dict)] if isinstance(raw_title_blocks, list) else []
    if not title_blocks:
        legacy_title = str(parent.get("title") or "").strip()
        if legacy_title:
            title_blocks = [{"logicalField": "title", "physicalField": "title", "text": legacy_title}]
    title, canonical_title_blocks = render_field_section(title_blocks, "TITLE")
    body = body.strip()
    title = title.strip() or None
    if not body:
        return []
    # Repeating an oversized title on every body chunk can make every
    # embedding request invalid.  Fold its labeled fields into the chunkable
    # body stream instead: no title content is dropped, while the original
    # title remains available on each indexed document for display/BM25.
    title_folded_into_body = bool(title and estimate_tokens(title) >= max_tokens)
    embedding_title = title
    if title_folded_into_body:
        body, canonical_body_blocks = render_field_section(
            [*canonical_title_blocks, *canonical_body_blocks],
            "BODY",
        )
        body = body.strip()
        embedding_title = None
    full_text = build_embedding_text(embedding_title, body)
    sentences = split_sentences(body)
    title_tokens = estimate_tokens(embedding_title or "")
    body_render_overhead = _field_section_overhead(canonical_body_blocks, "BODY")
    body_max_tokens = max(1, max_tokens - title_tokens - body_render_overhead)
    body_target_tokens = max(1, target_tokens - title_tokens - body_render_overhead)
    effective_overlap = min(overlap_tokens, max(0, body_max_tokens - 1))
    sentences = [expanded for sentence in sentences for expanded in _split_long_sentence(sentence, max_tokens=body_max_tokens, overlap_tokens=effective_overlap)]
    sentences = [type(sentence)(index, sentence.text, sentence.start, sentence.end, sentence.token_count) for index, sentence in enumerate(sentences)]
    total_tokens = estimate_tokens(full_text)
    strategy = "semantic_embedding"
    fallback_reason: str | None = None
    if not sentences or total_tokens <= target_tokens:
        segments = [ChunkSegment(0, len(sentences), total_tokens, 0, len(body))]
    else:
        vectors = embed_sentences([sentence.text for sentence in sentences])
        candidates = build_embedding_boundary_candidates(
            sentences,
            vectors,
            target_tokens=body_target_tokens,
            overlap_tokens=effective_overlap,
            max_tokens=body_max_tokens,
        )
        needs_llm = total_tokens >= max_tokens or any(segment.ambiguous for segment in candidates)
        segments = candidates
        if needs_llm:
            candidate_boundaries = [segment.end_sentence - 1 for segment in candidates[:-1]]
            context_sentences = [{"index": sentence.index, "text": sentence.text} for sentence in sentences]
            try:
                refined_raw = refine_boundaries(context_sentences, candidate_boundaries)
                refined = _valid_refined_segments(refined_raw, len(sentences))
                if not refined:
                    fallback_reason = "invalid_segment_response"
            except TimeoutError:
                refined = None
                fallback_reason = "gateway_timeout"
            except ValueError as exc:
                refined = None
                fallback_reason = "refinement_budget_exceeded" if "budget" in str(exc).casefold() or "24_000" in str(exc) else "gateway_validation_error"
            except Exception as exc:
                refined = None
                fallback_reason = f"gateway_{exc.__class__.__name__.casefold()}"
            if refined:
                refined_with_overlap = _apply_overlap(refined, sentences, effective_overlap)
                if all(segment.token_count + title_tokens <= max_tokens for segment in refined_with_overlap):
                    segments = refined_with_overlap
                    strategy = "semantic_embedding_llm"
                else:
                    strategy = "semantic_embedding_fallback"
                    fallback_reason = fallback_reason or "refined_chunk_exceeds_max_tokens"
            else:
                strategy = "semantic_embedding_fallback"
                fallback_reason = fallback_reason or "invalid_segment_response"
        else:
            strategy = "semantic_embedding"

    if title_folded_into_body:
        strategy = f"{strategy}_title_folded"
        fallback_reason = (
            "title_exceeds_chunk_budget"
            if not fallback_reason
            else f"title_exceeds_chunk_budget;{fallback_reason}"
        )

    result: list[dict[str, Any]] = []
    metadata = parent.get("metadata") if isinstance(parent.get("metadata"), dict) else {}
    metadata_display = parent.get("metadata_display") if isinstance(parent.get("metadata_display"), dict) else {}
    source_fields = _merge_source_fields(
        parent.get("source_fields") if isinstance(parent.get("source_fields"), list) else []
    )
    for index, segment in enumerate(segments):
        text, chunk_body_blocks = render_field_section_range(
            canonical_body_blocks,
            "BODY",
            segment.char_start,
            segment.char_end,
        )
        if not text.strip() or text.strip() == "[BODY]\n[/BODY]":
            text = body[segment.char_start:segment.char_end].strip() if segment.char_end else " ".join(sentence.text for sentence in sentences[segment.start_sentence:segment.end_sentence])
            chunk_body_blocks = []
        if not text:
            continue
        effective_embedding_text = build_embedding_text(embedding_title, text)
        if estimate_tokens(effective_embedding_text) > max_tokens:
            raise PermanentRagContractError("RAG_CHUNK_EXCEEDS_MAX_TOKENS")
        chunk_id = chunk_document_id(str(parent["parent_document_id"]), index, effective_embedding_text, metadata)
        chunk_content_hash = hashlib.sha256(effective_embedding_text.encode("utf-8")).hexdigest()
        included_keys = {
            (str(field.get("logicalField") or ""), str(field.get("physicalField") or field.get("logicalField") or ""))
            for field in [*chunk_body_blocks, *canonical_title_blocks]
            if isinstance(field, dict) and field.get("logicalField")
        }
        included_source_fields = [
            field
            for field in source_fields
            if set(_field_roles(field)) & {"body", "title"}
            and (
                str(field.get("logicalField") or ""),
                str(field.get("physicalField") or field.get("logicalField") or ""),
            )
            in included_keys
        ]
        result.append({
            "schema_version": CHUNKING_VERSION,
            "job_id": parent.get("job_id"),
            "chunk_document_id": chunk_id,
            "parent_document_id": str(parent["parent_document_id"]),
            "dataset_id": str(parent["dataset_id"]),
            "source_fingerprint": str(parent["source_fingerprint"]),
            "source_row_id": str(parent["source_row_id"]),
            "chunk_index": index,
            "chunk_count": 0,
            "start_sentence": segment.start_sentence,
            "end_sentence": segment.end_sentence - 1,
            "char_start": segment.char_start,
            "char_end": segment.char_end,
            "text": text,
            "body": text,
            "embedding_text": effective_embedding_text,
            "title": title,
            "title_blocks": canonical_title_blocks,
            "body_blocks": chunk_body_blocks,
            "metadata": metadata,
            "metadata_display": metadata_display,
            "semantic_bindings": parent.get("semantic_bindings") or {},
            "source_columns": list(
                dict.fromkeys(
                    str(column)
                    for column in (
                        parent.get("source_columns")
                        or [field.get("logicalField") for field in source_fields]
                    )
                    if str(column or "").strip()
                )
            ),
            "source_fields": included_source_fields,
            "parent_source_fields": source_fields,
            "content_hash": chunk_content_hash,
            "chunking_strategy": strategy,
            "chunking_version": CHUNKING_VERSION,
            "embedding_input_version": EMBEDDING_INPUT_VERSION,
            "field_rendering_version": FIELD_RENDERING_VERSION,
            "token_count": estimate_tokens(effective_embedding_text),
            "embedding_status": "pending",
            "embedding_model": parent.get("embedding_model"),
            "embedding_dimensions": parent.get("embedding_dimensions"),
            "fallback_applied": fallback_reason is not None,
            "fallback_reason": fallback_reason,
        })
    for chunk in result:
        chunk["chunk_count"] = len(result)
    return result
