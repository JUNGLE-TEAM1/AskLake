from app.rag_core import (
    CHUNKING_VERSION,
    build_embedding_boundary_candidates,
    build_embedding_text,
    chunk_document_id,
    normalize_row,
    parent_document_id,
    split_sentences,
)


def test_normalize_row_flattens_nested_values_and_respects_catalog_schema() -> None:
    row = {"review": {"text": "  fast delivery ", "rating": 5}, "extra": "ignore", "tags": ["safe", "quick"]}
    normalized = normalize_row(row, ["review.text", "review.rating", "tags"])
    assert normalized == {"review.text": "fast delivery", "review.rating": 5, "tags": '["safe","quick"]'}


def test_title_and_body_are_combined_without_rewriting() -> None:
    assert build_embedding_text("배송 후기", "포장이 안전했습니다.") == "배송 후기\n\n포장이 안전했습니다."
    assert build_embedding_text(None, "본문") == "본문"


def test_sentence_split_preserves_order_and_content() -> None:
    sentences = split_sentences("첫 문장입니다. 둘째 문장입니다!\n\n셋째 문장입니다.")
    assert [item.index for item in sentences] == [0, 1, 2]
    assert " ".join(item.text for item in sentences) == "첫 문장입니다. 둘째 문장입니다! 셋째 문장입니다."


def test_short_document_is_single_chunk() -> None:
    sentences = split_sentences("짧은 리뷰입니다.")
    chunks = build_embedding_boundary_candidates(sentences)
    assert [(chunk.start_sentence, chunk.end_sentence) for chunk in chunks] == [(0, 1)]


def test_long_document_has_overlap_and_deterministic_ids() -> None:
    sentences = split_sentences(" ".join(f"문장 {index} 입니다." for index in range(300)))
    chunks = build_embedding_boundary_candidates(sentences, target_tokens=80, overlap_tokens=20, max_tokens=100)
    assert len(chunks) > 1
    assert any(left.end_sentence > right.start_sentence for left, right in zip(chunks, chunks[1:]))
    row = {"review_text": "본문", "rating": 5}
    parent = parent_document_id("reviews", "RV-1", row)
    first = chunk_document_id(parent, 0, "제목\n\n본문", {"rating": 5})
    second = chunk_document_id(parent, 0, "제목\n\n본문", {"rating": 5})
    assert first == second
    assert first == chunk_document_id(parent, 0, "제목\n\n본문", {"rating": 1})
    assert CHUNKING_VERSION == "rag-chunk-v3"
