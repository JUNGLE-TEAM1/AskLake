from app.metadata import typed_metadata_filter


def test_typed_metadata_filter_keeps_numeric_boolean_and_iso_date_types() -> None:
    result = typed_metadata_filter({"rating": 5, "verified": True, "created_at": "2026-01-01"})
    assert result["rating"]["type"] == "number"
    assert result["verified"]["type"] == "boolean"
    assert result["created_at"] == {"type": "date", "keyword": "2026-01-01", "date": "2026-01-01"}
