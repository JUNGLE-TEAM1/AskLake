import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from rag_parent_contract import (  # noqa: E402
    EMBEDDING_INPUT_VERSION,
    RAG_PARENT_SCHEMA_VERSION,
    build_parent_document,
    build_staging_paths,
    embedding_text,
    normalized_row,
    validate_parent_document,
)


def test_parent_document_is_deterministic_and_title_is_part_of_embedding_input():
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
    assert first["title"] == "배송"
    assert embedding_text(first["title"], first["body"]) == "배송\n\n포장이 안전했습니다"
    assert first["normalized_row"]["nested"] == {"a": 1}


def test_nested_values_and_arrays_are_retained_without_row_explosion():
    row = normalized_row({"payload": {"customer": {"id": "c-1"}}, "tags": ["a", "b"], "ignored": "x"}, ["payload", "tags"])
    assert row["payload"] == {"customer": {"id": "c-1"}}
    assert row["tags"] == ["a", "b"]
    assert "ignored" not in row


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
