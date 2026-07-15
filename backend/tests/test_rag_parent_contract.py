import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from rag_parent_contract import (  # noqa: E402
    EMBEDDING_INPUT_VERSION,
    RAG_PARENT_SCHEMA_VERSION,
    build_parent_document,
    build_staging_paths,
    embedding_text,
    failed_row_report,
    normalized_row,
    validate_parent_document,
)


def test_parent_document_is_deterministic_and_renders_ordered_labeled_fields():
    kwargs = dict(
        dataset_id="reviews",
        source_fingerprint="fp-1",
        row={"review_id": "r-1", "title": "배송", "review": "포장이 안전했습니다", "rating": 5, "nested": {"a": 1}},
        schema_columns=["review_id", "title", "review", "rating", "nested"],
        body_columns=["review"],
        title_columns=["title"],
        metadata_columns=["rating"],
        identifier_columns=["review_id"],
        ordinal=0,
        job_id="job-1",
        policy_fingerprint="policy-1",
        staged_at="2026-07-15T00:00:00Z",
    )
    first = build_parent_document(**kwargs)
    second = build_parent_document(**kwargs)
    assert first == second
    assert first["schema_version"] == RAG_PARENT_SCHEMA_VERSION
    assert first["embedding_input_version"] == EMBEDDING_INPUT_VERSION
    assert first["title"] == "[TITLE]\ntitle: 배송\n[/TITLE]"
    assert first["body"] == "[BODY]\nreview: 포장이 안전했습니다\n[/BODY]"
    assert embedding_text(first["title"], first["body"]) == f"{first['title']}\n\n{first['body']}"
    assert [field["logicalField"] for field in first["source_fields"]] == ["review", "title", "rating", "review_id"]
    assert first["normalized_row"]["nested"] == {"a": 1}


def test_nested_values_and_arrays_are_retained_without_row_explosion():
    row = normalized_row({"payload": {"customer": {"id": "c-1"}}, "tags": ["a", "b"], "ignored": "x"}, ["payload", "tags"])
    assert row["payload"] == {"customer": {"id": "c-1"}}
    assert row["tags"] == ["a", "b"]
    assert "ignored" not in row


def test_parent_normalized_row_contains_only_approved_role_columns():
    document = build_parent_document(
        dataset_id="reviews",
        source_fingerprint="fp-1",
        row={"review": "text", "rating": 5, "email": "private@example.com", "user_id": "u-1"},
        schema_columns=["review", "rating", "email", "user_id"],
        included_columns=["review", "rating", "user_id"],
        body_columns=["review"],
        title_columns=[],
        metadata_columns=["rating"],
        identifier_columns=["user_id"],
        ordinal=0,
        job_id="job-1",
        policy_fingerprint="policy-1",
    )
    assert "email" not in document["normalized_row"]
    assert "email" not in document["body"]
    assert "email" not in document["metadata"]
    assert document["normalized_row"] == {"rating": 5, "review": "text", "user_id": "u-1"}

    changed_excluded = build_parent_document(
        dataset_id="reviews",
        source_fingerprint="fp-1",
        row={"review": "text", "rating": 5, "email": "other@example.com", "user_id": "u-1"},
        schema_columns=["review", "rating", "email", "user_id"],
        included_columns=["review", "rating", "user_id"],
        body_columns=["review"], title_columns=[], metadata_columns=["rating"], identifier_columns=["user_id"],
        ordinal=0, job_id="job-1", policy_fingerprint="policy-1",
    )
    assert changed_excluded["parent_document_id"] == document["parent_document_id"]


def test_logical_and_physical_field_names_are_both_preserved_at_the_boundary():
    document = build_parent_document(
        dataset_id="reviews",
        source_fingerprint="fp-1",
        row={"review_rating": 3, "review_text": "late"},
        schema_columns=["review_rating", "review_text"],
        included_columns=["review_rating", "review_text"],
        body_columns=["Review Text"],
        title_columns=[],
        metadata_columns=["Review Rating"],
        identifier_columns=[],
        body_fields=[{"logicalField": "Review Text", "physicalField": "review_text", "dataType": "string"}],
        metadata_fields=[{"logicalField": "Review Rating", "physicalField": "review_rating", "dataType": "integer"}],
        logical_to_physical={"Review Text": "review_text", "Review Rating": "review_rating"},
        ordinal=0,
        job_id="job-1",
        policy_fingerprint="policy-1",
    )
    assert "Review Text: late" in document["body"]
    assert document["metadata"] == {"review_rating": 3}
    assert document["metadata_display"] == {"Review Rating": 3}
    assert document["source_fields"][0]["physicalField"] == "review_text"


def test_field_rendering_normalizes_catalog_scalar_types_deterministically():
    document = build_parent_document(
        dataset_id="events",
        source_fingerprint="fp-1",
        row={"text": "  event  ", "count": 3.0, "active": True, "when": "2026-07-15T12:30:00+00:00", "tags": {"z": 1, "a": 2}},
        schema_columns=["text", "count", "active", "when", "tags"],
        included_columns=["text", "count", "active", "when", "tags"],
        body_columns=["text", "count", "active", "when", "tags"],
        title_columns=[],
        metadata_columns=[],
        identifier_columns=[],
        body_fields=[
            {"logicalField": "text", "physicalField": "text", "dataType": "string"},
            {"logicalField": "count", "physicalField": "count", "dataType": "integer"},
            {"logicalField": "active", "physicalField": "active", "dataType": "boolean"},
            {"logicalField": "when", "physicalField": "when", "dataType": "timestamp"},
            {"logicalField": "tags", "physicalField": "tags", "dataType": "object"},
        ],
        ordinal=0,
        job_id="job-1",
        policy_fingerprint="policy-1",
    )
    assert "text: event" in document["body"]
    assert "count: 3" in document["body"]
    assert "active: true" in document["body"]
    assert 'tags: {"a":2,"z":1}' in document["body"]


def test_same_logical_fields_from_different_datasets_have_different_parent_identity():
    base = dict(
        source_fingerprint="fp-1",
        row={"id": "same", "review": "same"},
        schema_columns=["id", "review"],
        body_columns=["review"],
        title_columns=[],
        metadata_columns=[],
        identifier_columns=["id"],
        ordinal=0,
        job_id="job-1",
        policy_fingerprint="policy-1",
    )
    left = build_parent_document(dataset_id="dataset-a", **base)
    right = build_parent_document(dataset_id="dataset-b", **base)
    assert left["body"] == right["body"]
    assert left["parent_document_id"] != right["parent_document_id"]


def test_parent_validation_rejects_missing_contract_fields():
    try:
        validate_parent_document({"schema_version": RAG_PARENT_SCHEMA_VERSION})
    except ValueError as exc:
        assert "RAG_PARENT_REQUIRED_FIELDS_MISSING" in str(exc)
    else:
        raise AssertionError("expected invalid parent document")


def test_staging_paths_are_dataset_and_job_scoped():
    paths = build_staging_paths(base_path="s3a://lake/warehouse", dataset_id="reviews", job_id="job-1")
    assert paths["checkpoint"].endswith("dataset_id=reviews/job_id=job-1")
    assert paths["table"].endswith("rag/parents/dataset_id=reviews")


def test_failed_row_report_is_bounded_and_deterministic():
    assert failed_row_report(row_count=10, failed_count=12, threshold=0.05, quarantined_table="iceberg.rag.parents") == {
        "rowCount": 10,
        "validCount": 0,
        "failedCount": 10,
        "failedRate": 1.0,
        "threshold": 0.05,
        "quarantinedTable": "iceberg.rag.parents",
    }
