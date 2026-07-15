from app.document_builder import build_documents


def test_worker_builds_source_row_and_metadata_document() -> None:
    result = build_documents("reviews", "reviews", [{"review_id": "r1", "review_text": "great", "rating": 5}], ["review_text"], ["rating"], "reviews-v1")
    assert result[0]["source_row_id"] == "r1"
    assert result[0]["body"] == "[BODY]\nreview_text: great\n[/BODY]"
    assert result[0]["filter_terms"] == {"rating": "5"}
