import hashlib

from app.chunker import chunk_parent_document
from app.rag_core import estimate_tokens, render_field_section


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


def test_title_only_row_is_embedded_instead_of_dropped():
    parent = _parent("", title="Wireless headphones")
    parent["source_columns"] = ["product_name"]
    parent["source_fields"] = [
        {
            "logicalField": "product_name",
            "physicalField": "product_name",
            "role": "title",
            "roles": ["title"],
        }
    ]
    parent["title_blocks"] = [
        {
            "logicalField": "product_name",
            "physicalField": "product_name",
            "text": "Wireless headphones",
        }
    ]

    chunks = chunk_parent_document(
        parent,
        embed_sentences=lambda values: [],
        refine_boundaries=lambda sentences, boundaries: [],
    )

    assert len(chunks) == 1
    assert "product_name: Wireless headphones" in chunks[0]["embedding_text"]
    assert chunks[0]["chunking_strategy"] == "semantic_embedding_title_folded"
    assert chunks[0]["fallback_applied"] is False
    assert chunks[0]["fallback_reason"] is None
    assert chunks[0]["source_fields"][0]["roles"] == ["title"]


def test_chunk_provenance_merges_body_metadata_and_composite_identifier_roles():
    parent = _parent(
        "Audio t1 7",
        title=None,
        blocks=[
            {"logicalField": "category", "physicalField": "category", "text": "Audio"},
            {"logicalField": "tenant", "physicalField": "tenant", "text": "t1"},
            {"logicalField": "record", "physicalField": "record", "text": "7"},
        ],
    )
    parent["source_columns"] = ["category", "category", "tenant", "record", "tenant"]
    parent["source_fields"] = [
        {"logicalField": "category", "physicalField": "category", "role": "body"},
        {"logicalField": "category", "physicalField": "category", "role": "metadata"},
        {"logicalField": "tenant", "physicalField": "tenant", "role": "body", "roles": ["body", "identifier"]},
        {"logicalField": "record", "physicalField": "record", "role": "body"},
        {"logicalField": "record", "physicalField": "record", "role": "identifier"},
    ]

    chunk = chunk_parent_document(
        parent,
        embed_sentences=lambda values: [],
        refine_boundaries=lambda sentences, boundaries: [],
    )[0]
    assert chunk["source_columns"] == ["category", "tenant", "record"]
    assert len(chunk["source_fields"]) == 3
    roles = {field["logicalField"]: field["roles"] for field in chunk["source_fields"]}
    assert roles == {
        "category": ["body", "metadata"],
        "tenant": ["body", "identifier"],
        "record": ["body", "identifier"],
    }


def test_very_long_title_is_folded_and_fully_covered_by_bounded_chunks():
    markers = [f"marker{index}" for index in range(240)]
    parent = _parent(
        "short body",
        title=None,
        blocks=[{"logicalField": "description", "physicalField": "description", "text": "short body"}],
    )
    parent["title"] = " ".join(markers)
    parent["title_blocks"] = [
        {"logicalField": "product_name", "physicalField": "product_name", "text": " ".join(markers)}
    ]
    parent["source_columns"] = ["description", "product_name"]
    parent["source_fields"] = [
        {"logicalField": "description", "physicalField": "description", "role": "body", "roles": ["body"]},
        {"logicalField": "product_name", "physicalField": "product_name", "role": "title", "roles": ["title"]},
    ]
    chunks = chunk_parent_document(
        parent,
        embed_sentences=lambda values: [[1.0, 0.0] for _ in values],
        refine_boundaries=lambda sentences, boundaries: [
            {"startSentence": index, "endSentence": index}
            for index in range(len(sentences))
        ],
        target_tokens=60,
        overlap_tokens=0,
        max_tokens=80,
    )
    combined = "\n".join(chunk["embedding_text"] for chunk in chunks)
    assert len(chunks) > 1
    assert all(estimate_tokens(chunk["embedding_text"]) <= 80 for chunk in chunks)
    assert all(chunk["chunking_strategy"] == "semantic_embedding_llm_title_folded" for chunk in chunks)
    assert all(chunk["fallback_reason"] is None for chunk in chunks)
    assert all(chunk["fallback_applied"] is False for chunk in chunks)
    assert all(marker in combined for marker in markers)
    assert any(
        "title" in field["roles"]
        for chunk in chunks
        for field in chunk["source_fields"]
    )


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


def test_llm_segments_may_omit_only_the_closing_body_wrapper() -> None:
    body = " ".join(
        f"Sentence {index} preserves marker-{index}."
        for index in range(90)
    )
    blocks = [{"logicalField": "content", "physicalField": "content", "text": body}]
    parent = _parent(body, title="Long document", blocks=blocks)
    observed: dict[str, object] = {}

    def refine(sentences: list[dict], boundaries: list[int]) -> list[dict[str, int]]:
        observed["sentence_count"] = len(sentences)
        observed["last_sentence"] = sentences[-1]["text"].strip()
        meaningful_last = len(sentences) - 2
        ranges: list[dict[str, int]] = []
        start = 0
        for end in (value for value in boundaries if value <= meaningful_last):
            if end >= start:
                ranges.append({"startSentence": start, "endSentence": end})
                start = end + 1
        if start <= meaningful_last:
            ranges.append({"startSentence": start, "endSentence": meaningful_last})
        return ranges

    chunks = chunk_parent_document(
        parent,
        embed_sentences=lambda values: [[1.0, 0.0] for _ in values],
        refine_boundaries=refine,
        target_tokens=80,
        overlap_tokens=10,
        max_tokens=120,
    )
    rendered_body, _ = render_field_section(blocks, "BODY")
    combined = "\n".join(chunk["embedding_text"] for chunk in chunks)

    assert observed == {"sentence_count": 91, "last_sentence": "[/BODY]"}
    assert len(chunks) > 1
    assert all(chunk["chunking_strategy"] == "semantic_embedding_llm" for chunk in chunks)
    assert all(chunk["fallback_applied"] is False for chunk in chunks)
    assert all(chunk["fallback_reason"] is None for chunk in chunks)
    assert all(estimate_tokens(chunk["embedding_text"]) <= 120 for chunk in chunks)
    assert all(f"marker-{index}" in combined for index in range(90))
    assert chunks[0]["char_start"] == 0
    assert chunks[-1]["char_end"] == len(rendered_body.strip())
    assert chunks[-1]["body"].endswith("[/BODY]")
