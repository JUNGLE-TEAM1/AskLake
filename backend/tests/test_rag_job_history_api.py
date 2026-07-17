from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.rag import router as rag_router
from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.models.base import Base
from app.models.semantic_rag import RagIndexJobModel, RagDatasetProfileModel
from app.schemas.common import ErrorCode
from app.schemas.semantic import RagApproveRequest, RagJobListItem
from app.services.rag_service import (
    RAG_JOB_LIST_DEFAULT_LIMIT,
    RAG_JOB_LIST_MAX_LIMIT,
    RAG_JOB_STAGES,
    RAG_TABLES,
    RagService,
)


NOW = datetime(2026, 7, 17, 6, 0, tzinfo=timezone.utc)


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as session:
        yield session
    engine.dispose()


def job_model(**overrides: object) -> RagIndexJobModel:
    values: dict[str, object] = {
        "id": "ragjob_test",
        "dataset_id": "reviews",
        "requested_by": "admin",
        "requested_mode": "index",
        "status": "queued",
        "stage": "queued",
        "document_count": 0,
        "indexed_count": 0,
        "parent_count": 0,
        "chunk_count": 0,
        "failed_count": 0,
        "row_count": 0,
        "fallback_count": 0,
        "embedding_provider": None,
        "embedding_model": None,
        "embedding_dimensions": None,
        "validation_status": "pending",
        "validated_at": None,
        "validated_index": None,
        "validated_document_count": None,
        "validated_parent_count": None,
        "validated_dimensions": None,
        "validation_evidence_hash": None,
        "activation_status": "none",
        "activation_alias": None,
        "activation_previous_index": None,
        "activation_target_index": None,
        "activation_started_at": None,
        "activation_committed_at": None,
        "error": None,
        "created_at": NOW,
        "updated_at": NOW,
        "completed_at": None,
    }
    values.update(overrides)
    return RagIndexJobModel(**values)


def project_job(**overrides: object) -> RagJobListItem:
    return RagService._job_list_item(job_model(**overrides))


def catalog_dataset() -> dict[str, object]:
    names = ["content", "title", "category", "id", "unused"]
    return {
        "id": "reviews",
        "name": "Reviews",
        "owner": "admin",
        "permissionGrants": [],
        "schema": [{"name": name, "dataType": "string"} for name in names],
        "sampleRows": [],
    }


def approval_payload() -> dict[str, list[str]]:
    return {
        "bodyColumns": ["content"],
        "titleColumns": ["title"],
        "metadataColumns": ["category"],
        "identifierColumns": ["id"],
        "excludedColumns": ["unused"],
    }


def approve(service: RagService, payload: dict[str, list[str]], monkeypatch: pytest.MonkeyPatch) -> None:
    dataset = catalog_dataset()
    monkeypatch.setattr(service, "_dataset", lambda *_args, **_kwargs: dataset)
    monkeypatch.setattr(service, "profile", lambda *_args, **_kwargs: object())
    service.approve(
        "reviews",
        RagApproveRequest.model_validate(payload),
        ActorContext(name="admin", role="admin"),
    )


def test_job_list_schema_is_strict_and_serializes_only_declared_camel_case_fields() -> None:
    item = project_job()
    payload = item.model_dump(by_alias=True, mode="json")

    assert set(payload) == {
        "jobId",
        "datasetId",
        "requestedMode",
        "status",
        "stage",
        "progressPercent",
        "documentCount",
        "indexedCount",
        "parentCount",
        "chunkCount",
        "failedCount",
        "rowCount",
        "fallbackCount",
        "embeddingProvider",
        "embeddingModel",
        "embeddingDimensions",
        "validationStatus",
        "validatedAt",
        "validatedIndex",
        "validatedDocumentCount",
        "validatedParentCount",
        "validatedDimensions",
        "validationEvidenceHash",
        "activationStatus",
        "activationAlias",
        "activationPreviousIndex",
        "activationTargetIndex",
        "activationStartedAt",
        "activationCommittedAt",
        "error",
        "createdAt",
        "updatedAt",
        "completedAt",
    }
    invalid_type = item.model_dump()
    invalid_type["document_count"] = "0"
    with pytest.raises(ValidationError):
        RagJobListItem.model_validate(invalid_type)
    unexpected_field = item.model_dump()
    unexpected_field["unexpected"] = "reviews"
    with pytest.raises(ValidationError):
        RagJobListItem.model_validate(unexpected_field)
    missing_field = item.model_dump()
    del missing_field["embedding_provider"]
    with pytest.raises(ValidationError):
        RagJobListItem.model_validate(missing_field)


def test_job_stage_progress_is_the_monotonic_seven_stage_ratio_not_a_time_estimate() -> None:
    projected = [
        project_job(status=stage, stage=stage)
        for stage in RAG_JOB_STAGES[:-1]
    ]
    completed = project_job(
        status="ready",
        stage="ready",
        validation_status="passed",
        activation_status="committed",
        completed_at=NOW,
    )

    assert [item.stage for item in projected] == list(RAG_JOB_STAGES[:-1])
    assert [item.progress_percent for item in projected] == [0, 16, 33, 50, 66, 83]
    assert completed.stage == "ready"
    assert completed.progress_percent == 100
    assert project_job(status="indexing", stage="indexing", chunk_count=8, indexed_count=3).progress_percent == 72
    assert project_job(status="indexing", stage="indexing", chunk_count=8, indexed_count=8).progress_percent == 83


def test_incomplete_ready_state_never_reports_ready_or_one_hundred_percent() -> None:
    item = project_job(
        status="ready",
        stage="ready",
        document_count=8,
        indexed_count=8,
        parent_count=4,
        chunk_count=8,
        embedding_provider="openai_compatible",
        embedding_model="text-embedding-3-small",
        embedding_dimensions=1536,
        validation_status="passed",
        validated_at=NOW,
        validated_index="rag-reviews-v2",
        validated_document_count=8,
        validated_parent_count=4,
        validated_dimensions=1536,
        validation_evidence_hash="evidence",
        activation_status="pending",
        activation_alias="rag-reviews",
        activation_target_index="rag-reviews-v2",
        activation_started_at=NOW,
    )

    assert item.status == "ready"
    assert item.stage == "validating"
    assert item.progress_percent == 83
    assert item.completed_at is None


@pytest.mark.parametrize(
    ("validation_status", "activation_status", "completed_at"),
    [
        ("pending", "committed", NOW),
        ("passed", "pending", NOW),
        ("passed", "committed", None),
    ],
)
def test_each_completion_gate_independently_blocks_one_hundred_percent(
    validation_status: str,
    activation_status: str,
    completed_at: datetime | None,
) -> None:
    item = project_job(
        status="ready",
        stage="ready",
        chunk_count=10,
        indexed_count=10,
        validation_status=validation_status,
        activation_status=activation_status,
        completed_at=completed_at,
    )

    assert item.stage == "validating"
    assert item.progress_percent == 83


@pytest.mark.parametrize(
    ("status", "counts", "expected_stage", "expected_progress"),
    [
        ("failed", {"chunk_count": 8, "indexed_count": 3}, "indexing", 72),
        ("canceled", {"row_count": 5, "parent_count": 4}, "staging", 16),
        ("failed", {"validation_status": "failed"}, "validating", 83),
    ],
)
def test_failed_and_canceled_jobs_show_last_evidenced_stage(
    status: str,
    counts: dict[str, object],
    expected_stage: str,
    expected_progress: int,
) -> None:
    item = project_job(status=status, stage=status, error="stopped", completed_at=NOW, **counts)

    assert item.status == status
    assert item.stage == expected_stage
    assert item.progress_percent == expected_progress


def test_list_jobs_checks_view_permission_and_scopes_orders_and_limits_rows(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    older = job_model(id="ragjob_old", created_at=NOW - timedelta(hours=2), updated_at=NOW - timedelta(hours=2))
    newer = job_model(
        id="ragjob_new",
        requested_mode="reindex",
        status="indexing",
        stage="indexing",
        document_count=10,
        indexed_count=4,
        parent_count=5,
        chunk_count=10,
        fallback_count=2,
        embedding_provider="openai_compatible",
        embedding_model="text-embedding-3-small",
        embedding_dimensions=1536,
        created_at=NOW - timedelta(hours=1),
        updated_at=NOW,
    )
    other_dataset = job_model(
        id="ragjob_other",
        dataset_id="orders",
        created_at=NOW,
        updated_at=NOW,
    )
    db.add_all([older, newer, other_dataset])
    db.commit()
    service = RagService(db)
    permission_checks: list[tuple[str, str]] = []
    monkeypatch.setattr(service, "_dataset", lambda dataset_id, _actor, action: permission_checks.append((dataset_id, action)) or {})

    limited = service.list_jobs("reviews", ActorContext(name="viewer"), limit=1)
    all_reviews = service.list_jobs("reviews", ActorContext(name="viewer"), limit=10)

    assert [item.job_id for item in limited] == ["ragjob_new"]
    assert [item.job_id for item in all_reviews] == ["ragjob_new", "ragjob_old"]
    assert all(item.job_id != "ragjob_other" for item in all_reviews)
    assert limited[0].requested_mode == "reindex"
    assert limited[0].progress_percent == 72
    assert limited[0].fallback_count == 2
    assert permission_checks == [("reviews", "view"), ("reviews", "view")]


def test_list_jobs_propagates_dataset_view_denial_before_reading_jobs(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    service = RagService(db)

    def deny(_dataset_id: str, _actor: ActorContext, action: str) -> dict[str, object]:
        assert action == "view"
        raise ApiError(ErrorCode.FORBIDDEN, "forbidden", 403)

    monkeypatch.setattr(service, "_dataset", deny)
    with pytest.raises(ApiError) as raised:
        service.list_jobs("reviews", ActorContext(name="blocked"))

    assert raised.value.code == ErrorCode.FORBIDDEN


@pytest.mark.parametrize("limit", [0, RAG_JOB_LIST_MAX_LIMIT + 1, True, 1.5, "10"])
def test_list_jobs_service_rejects_unbounded_or_non_integer_limits(db: Session, limit: object) -> None:
    with pytest.raises(ApiError) as raised:
        RagService(db).list_jobs("reviews", ActorContext(name="viewer"), limit=limit)  # type: ignore[arg-type]

    assert raised.value.code == ErrorCode.VALIDATION_ERROR


def test_jobs_endpoint_applies_default_and_max_limit_and_rejects_invalid_values(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI()
    app.include_router(rag_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_actor_context] = lambda: ActorContext(name="viewer")
    observed_limits: list[int] = []

    def fake_list_jobs(_service: RagService, dataset_id: str, _actor: ActorContext, *, limit: int) -> list[RagJobListItem]:
        assert dataset_id == "reviews"
        observed_limits.append(limit)
        return [project_job()]

    monkeypatch.setattr(RagService, "list_jobs", fake_list_jobs)

    with TestClient(app) as client:
        default_response = client.get("/api/catalog/datasets/reviews/rag/jobs")
        max_response = client.get(f"/api/catalog/datasets/reviews/rag/jobs?limit={RAG_JOB_LIST_MAX_LIMIT}")
        zero_response = client.get("/api/catalog/datasets/reviews/rag/jobs?limit=0")
        excessive_response = client.get(f"/api/catalog/datasets/reviews/rag/jobs?limit={RAG_JOB_LIST_MAX_LIMIT + 1}")
        invalid_response = client.get("/api/catalog/datasets/reviews/rag/jobs?limit=not-an-integer")

    assert default_response.status_code == 200
    assert default_response.json()[0]["jobId"] == "ragjob_test"
    assert default_response.json()[0]["datasetId"] == "reviews"
    assert max_response.status_code == 200
    assert [zero_response.status_code, excessive_response.status_code, invalid_response.status_code] == [422, 422, 422]
    assert observed_limits == [RAG_JOB_LIST_DEFAULT_LIMIT, RAG_JOB_LIST_MAX_LIMIT]


def test_approve_allows_only_body_metadata_and_body_identifier_dual_roles(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    service = RagService(db)
    payload = approval_payload()
    payload["bodyColumns"] = ["content", "category", "id"]

    approve(service, payload, monkeypatch)

    profile = db.get(RagDatasetProfileModel, "reviews")
    assert profile is not None
    assert profile.review_state == "approved"
    assert profile.body_columns == ["content", "category", "id"]
    assert profile.metadata_columns == ["category"]
    assert profile.identifier_columns == ["id"]


@pytest.mark.parametrize(
    ("left_field", "right_field", "column"),
    [
        ("bodyColumns", "titleColumns", "content"),
        ("titleColumns", "metadataColumns", "title"),
        ("titleColumns", "identifierColumns", "title"),
        ("metadataColumns", "identifierColumns", "category"),
    ],
)
def test_approve_rejects_all_disallowed_active_role_overlaps(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    left_field: str,
    right_field: str,
    column: str,
) -> None:
    service = RagService(db)
    payload = approval_payload()
    payload[left_field] = [column]
    payload[right_field] = [column]

    with pytest.raises(ApiError) as raised:
        approve(service, payload, monkeypatch)

    assert f"{left_field} and {right_field} cannot overlap" in raised.value.message


@pytest.mark.parametrize("active_field", ["bodyColumns", "titleColumns", "metadataColumns", "identifierColumns"])
def test_approve_rejects_excluded_overlap_with_every_active_role(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    active_field: str,
) -> None:
    service = RagService(db)
    payload = approval_payload()
    conflict = payload[active_field][0]
    payload["excludedColumns"] = [conflict]

    with pytest.raises(ApiError) as raised:
        approve(service, payload, monkeypatch)

    assert "excludedColumns cannot overlap another RAG role" in raised.value.message
    assert conflict in raised.value.message


@pytest.mark.parametrize(
    ("field", "duplicate"),
    [
        ("bodyColumns", "content"),
        ("titleColumns", "title"),
        ("metadataColumns", "category"),
        ("identifierColumns", "id"),
        ("excludedColumns", "unused"),
    ],
)
def test_approve_rejects_duplicates_inside_each_role_list(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    duplicate: str,
) -> None:
    service = RagService(db)
    payload = approval_payload()
    payload[field] = [duplicate, duplicate]

    with pytest.raises(ApiError) as raised:
        approve(service, payload, monkeypatch)

    assert raised.value.message == f"{field} cannot contain duplicate columns"


def test_approve_keeps_schema_scope_and_stable_identifier_requirements(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    service = RagService(db)
    outside_schema = approval_payload()
    outside_schema["bodyColumns"] = ["missing"]
    with pytest.raises(ApiError) as missing_column:
        approve(service, outside_schema, monkeypatch)
    assert missing_column.value.message == "RAG columns must exist in the Catalog Dataset schema"

    db.rollback()
    missing_identifier = approval_payload()
    missing_identifier["identifierColumns"] = []
    with pytest.raises(ApiError) as no_identifier:
        approve(service, missing_identifier, monkeypatch)
    assert "at least one stable identifier" in no_identifier.value.message
