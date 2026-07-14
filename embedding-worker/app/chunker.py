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
    ChunkSegment,
    build_embedding_boundary_candidates,
    build_embedding_text,
    chunk_document_id,
    estimate_tokens,
    _overlap_start,
    split_sentences,
)


SentenceEmbedder = Callable[[list[str]], list[list[float]]]
BoundaryRefiner = Callable[[list[dict[str, Any]], list[int]], list[dict[str, int]]]


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


def chunk_parent_document(
    parent: dict[str, Any],
    *,
    embed_sentences: SentenceEmbedder,
    refine_boundaries: BoundaryRefiner,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[dict[str, Any]]:
    body = str(parent.get("body") or "").strip()
    if not body:
        return []
    title = str(parent.get("title") or "").strip() or None
    full_text = build_embedding_text(title, body)
    sentences = split_sentences(body)
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
            target_tokens=target_tokens,
            overlap_tokens=overlap_tokens,
            max_tokens=max_tokens,
        )
        needs_llm = total_tokens > max_tokens or any(segment.ambiguous for segment in candidates)
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
                refined_with_overlap = _apply_overlap(refined, sentences, overlap_tokens)
                if all(segment.token_count <= max_tokens or segment.end_sentence - segment.start_sentence == 1 for segment in refined_with_overlap):
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

    result: list[dict[str, Any]] = []
    metadata = parent.get("metadata") if isinstance(parent.get("metadata"), dict) else {}
    for index, segment in enumerate(segments):
        text = body[segment.char_start:segment.char_end].strip() if segment.char_end else " ".join(sentence.text for sentence in sentences[segment.start_sentence:segment.end_sentence])
        if not text:
            continue
        effective_embedding_text = build_embedding_text(title, text)
        chunk_id = chunk_document_id(str(parent["parent_document_id"]), index, effective_embedding_text, metadata)
        chunk_content_hash = hashlib.sha256(effective_embedding_text.encode("utf-8")).hexdigest()
        result.append({
            "schema_version": "rag-chunk-v2",
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
            "embedding_text": effective_embedding_text,
            "title": title,
            "metadata": metadata,
            "semantic_bindings": parent.get("semantic_bindings") or {},
            "source_columns": list(parent.get("source_columns") or []),
            "content_hash": chunk_content_hash,
            "chunking_strategy": strategy,
            "chunking_version": CHUNKING_VERSION,
            "token_count": estimate_tokens(effective_embedding_text),
            "embedding_status": "pending",
            "embedding_model": parent.get("embedding_model"),
            "embedding_dimensions": parent.get("embedding_dimensions"),
            "fallback_applied": strategy == "semantic_embedding_fallback",
            "fallback_reason": fallback_reason,
        })
    for chunk in result:
        chunk["chunk_count"] = len(result)
    return result
