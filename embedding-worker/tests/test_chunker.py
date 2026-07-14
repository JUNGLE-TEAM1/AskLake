from app.chunker import chunk_parent_document


def test_short_parent_creates_one_chunk_without_ai_refinement():
    calls = {"embed": 0, "refine": 0}

    def embed(values):
        calls["embed"] += 1
        return [[1.0, 0.0] for _ in values]

    def refine(sentences, boundaries):
        calls["refine"] += 1
        return []

    chunks = chunk_parent_document(
        {"parent_document_id": "p1", "dataset_id": "d1", "source_fingerprint": "fp", "source_row_id": "r1", "title": "배송", "body": "포장이 안전했습니다.", "metadata": {"rating": 5}, "source_columns": ["review"], "content_hash": "c1"},
        embed_sentences=embed,
        refine_boundaries=refine,
    )
    assert len(chunks) == 1
    assert chunks[0]["embedding_text"] == "배송\n\n포장이 안전했습니다."
    assert calls == {"embed": 0, "refine": 0}


def test_long_parent_uses_embedding_boundaries_and_llm_only_for_refinement():
    calls = {"embed": 0, "refine": 0}
    body = " ".join(f"문장 {index}의 내용이 충분히 길다." for index in range(30))

    def embed(values):
        calls["embed"] += 1
        return [[1.0, 0.0] if index % 2 else [0.0, 1.0] for index, _ in enumerate(values)]

    def refine(sentences, boundaries):
        calls["refine"] += 1
        return [{"startSentence": start, "endSentence": min(start + 4, len(sentences) - 1)} for start in range(0, len(sentences), 5)]

    chunks = chunk_parent_document(
        {"parent_document_id": "p1", "dataset_id": "d1", "source_fingerprint": "fp", "source_row_id": "r1", "title": None, "body": body, "metadata": {}, "source_columns": [], "content_hash": "c1"},
        embed_sentences=embed,
        refine_boundaries=refine,
        target_tokens=20,
        overlap_tokens=4,
        max_tokens=100,
    )
    assert calls["embed"] == 1
    assert calls["refine"] == 1
    assert chunks[0]["chunking_strategy"] == "semantic_embedding_llm"


def test_llm_logical_boundaries_still_receive_configured_overlap():
    body = " ".join(f"문장 {index}의 내용이 길다." for index in range(20))
    chunks = chunk_parent_document(
        {"parent_document_id": "p1", "dataset_id": "d1", "source_fingerprint": "fp", "source_row_id": "r1", "body": body, "metadata": {}, "source_columns": [], "content_hash": "c1"},
        embed_sentences=lambda values: [[1.0, 0.0] for _ in values],
        refine_boundaries=lambda sentences, boundaries: [{"startSentence": 0, "endSentence": 9}, {"startSentence": 10, "endSentence": 19}],
        target_tokens=20,
        overlap_tokens=4,
        max_tokens=200,
    )
    assert len(chunks) == 2
    assert chunks[1]["start_sentence"] < 10


def test_invalid_llm_result_falls_back_to_embedding_boundaries():
    body = " ".join(f"문장 {index}의 내용이 길다." for index in range(20))
    chunks = chunk_parent_document(
        {"parent_document_id": "p1", "dataset_id": "d1", "source_fingerprint": "fp", "source_row_id": "r1", "body": body, "metadata": {}, "source_columns": [], "content_hash": "c1"},
        embed_sentences=lambda values: [[1.0, 0.0] for _ in values],
        refine_boundaries=lambda sentences, boundaries: [{"startSentence": 2, "endSentence": 3}],
        target_tokens=20,
        overlap_tokens=4,
        max_tokens=25,
    )
    assert chunks
    assert all(chunk["chunking_strategy"] == "semantic_embedding_fallback" for chunk in chunks)
