from app.document_builder import build_documents


def test_worker_builds_source_row_and_metadata_document() -> None:
    result = build_documents("reviews", "reviews", [{"review_id": "r1", "review_text": "great", "rating": 5}], ["review_text"], ["rating"], "reviews-v1")
    assert result[0]["source_row_id"] == "r1"
    assert result[0]["body"] == "[BODY]\nreview_text: great\n[/BODY]"
    assert result[0]["filter_terms"] == {"rating": "5"}


def test_worker_embeds_all_selected_document_fields_and_keeps_dual_use_metadata() -> None:
    result = build_documents(
        "products",
        "Amazon products",
        [{
            "product_id": "p1",
            "title": "Wireless headphones",
            "description": "Noise cancelling over-ear headphones",
            "category": "Audio",
            "rating": 4.7,
        }],
        ["description", "category", "rating"],
        ["category"],
        "products-v1",
        title_columns=["title"],
        identifier_columns=["product_id"],
    )

    document = result[0]
    assert document["embedding_text"] == (
        "[TITLE]\ntitle: Wireless headphones\n[/TITLE]\n\n"
        "[BODY]\ndescription: Noise cancelling over-ear headphones\n"
        "\ncategory: Audio\n\nrating: 4.7\n[/BODY]"
    )
    assert document["metadata_display"] == {"category": "Audio"}
    category_field = next(
        field for field in document["source_fields"]
        if field["logicalField"] == "category"
    )
    assert category_field["role"] == "body"
    assert category_field["roles"] == ["body", "metadata"]
    assert document["source_columns"].count("category") == 1


def test_worker_uses_production_composite_identifier_and_rejects_partial_keys() -> None:
    document = build_documents(
        "events",
        "Events",
        [{"tenant": "t1", "record": 7, "text": "hello"}],
        ["text", "tenant"],
        [],
        "events-v1",
        identifier_columns=["tenant", "record"],
    )[0]
    assert document["source_row_id"] == "identifier:0989c08947a2469089d3361e0b0b0079"
    tenant_field = next(field for field in document["source_fields"] if field["logicalField"] == "tenant")
    assert tenant_field["roles"] == ["body", "identifier"]
    assert document["source_columns"].count("tenant") == 1

    try:
        build_documents(
            "events",
            "Events",
            [{"tenant": "t1", "record": None, "text": "hello"}],
            ["text"],
            [],
            "events-v1",
            identifier_columns=["tenant", "record"],
        )
    except ValueError as exc:
        assert "RAG_SOURCE_IDENTIFIER_MISSING" in str(exc)
    else:
        raise AssertionError("partial composite identifiers must be rejected")
