import hashlib

from app.chunker import chunk_parent_document
from app.rag_core import estimate_tokens


def _parent(body: str, *, title: str | None = "delivery", blocks: list[dict] | None = None) -> dict:
    source_fields = [
        {"logicalField": block["logicalField"], "physicalField": block.get("physicalField", block["logicalField"]), "role": "body"}
        for block in (blocks or [{"logicalField": "review_text", "physicalField": "review_text"}])
    ]
    return {
        "parent_document_id": "p1",
        "dataset_id": "d1",
        "source_fingerprint": "fp",
        "source_row_id": "r1",
        "title": title,
        "body": body,
        "body_blocks": blocks,
        "metadata": {"rating": 5},
        "metadata_display": {"rating": 5},
        "source_columns": ["review_text"],
        "source_fields": source_fields,
        "content_hash": "c1",
    }


def test_short_parent_creates_one_structured_chunk_without_ai_refinement():
    calls = {"embed": 0, "refine": 0}

    chunks = chunk_parent_document(
        _parent("safe packaging"),
        embed_sentences=lambda values: calls.__setitem__("embed", calls["embed"] + 1) or [[1.0, 0.0] for _ in values],
        refine_boundaries=lambda sentences, boundaries: calls.__setitem__("refine", calls["refine"] + 1) or [],
    )
    assert len(chunks) == 1
    assert chunks[0]["embedding_text"] == "[TITLE]\ntitle: delivery\n[/TITLE]\n\n[BODY]\nbody: safe packaging\n[/BODY]"
    assert chunks[0]["body"].startswith("[BODY]\nbody: safe packaging")
    assert chunks[0]["field_rendering_version"] == "field_blocks_v1"
    assert chunks[0]["content_hash"] == hashlib.sha256(chunks[0]["embedding_text"].encode()).hexdigest()
    assert calls == {"embed": 0, "refine": 0}


def test_multiple_body_fields_keep_labels_even_when_values_match():
    blocks = [
        {"logicalField": "review_text", "physicalField": "review_text", "text": "same value"},
        {"logicalField": "seller_response", "physicalField": "seller_response", "text": "same value"},
    ]
    chunks = chunk_parent_document(_parent("ignored", blocks=blocks), embed_sentences=lambda values: [], refine_boundaries=lambda s, b: [])
    assert len(chunks) == 1
    assert "review_text: same value" in chunks[0]["body"]
    assert "seller_response: same value" in chunks[0]["body"]
    assert [item["logicalField"] for item in chunks[0]["body_blocks"]] == ["review_text", "seller_response"]
    assert [item["logicalField"] for item in chunks[0]["source_fields"]] == ["review_text", "seller_response"]
    assert [item["logicalField"] for item in chunks[0]["parent_source_fields"]] == ["review_text", "seller_response"]


def test_long_field_repeats_its_label_on_each_chunk():
    text = " ".join(f"event {index} payload" for index in range(500))
    blocks = [{"logicalField": "review_text", "physicalField": "review_text", "text": text}]
    chunks = chunk_parent_document(
        _parent(text, blocks=blocks),
        embed_sentences=lambda values: [[1.0, 0.0] for _ in values],
        refine_boundaries=lambda sentences, boundaries: [],
        target_tokens=80,
        overlap_tokens=20,
        max_tokens=100,
    )
    assert len(chunks) > 1
    assert all("review_text:" in chunk["body"] for chunk in chunks)
    assert all(estimate_tokens(chunk["embedding_text"]) <= 100 for chunk in chunks)
    assert any(left["char_end"] > right["char_start"] for left, right in zip(chunks, chunks[1:]))


def test_invalid_llm_result_falls_back_to_embedding_boundaries():
    body = " ".join(f"Sentence {index} has enough content." for index in range(80))
    chunks = chunk_parent_document(
        _parent(body),
        embed_sentences=lambda values: [[1.0, 0.0] for _ in values],
        refine_boundaries=lambda sentences, boundaries: [{"startSentence": 2, "endSentence": 3}],
        target_tokens=20,
        overlap_tokens=4,
        max_tokens=25,
    )
    assert chunks
    assert all(chunk["chunking_strategy"] == "semantic_embedding_fallback" for chunk in chunks)
    assert all(chunk["fallback_reason"] for chunk in chunks)
