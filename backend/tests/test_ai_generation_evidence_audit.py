import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.base import Base
from app.models.identity import AiGenerationUsageModel
from app.services.ai_generation_audit import persist_verified_generation_evidence


def test_verified_generation_evidence_is_persisted_with_stable_fingerprints() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[AiGenerationUsageModel.__table__])
    with Session(engine) as db:
        persist_verified_generation_evidence(
            db,
            actor=ActorContext(id="actor-1", name="Analyst", role="viewer"),
            candidate_ids=["doc-a", "doc-b"],
            context_payload={"datasetIds": ["dataset-1"], "prompt": "매출"},
            mode="query_sql",
            model="gpt-real",
            output_payload={"sql": "SELECT * FROM sales LIMIT 100;"},
            provider="openai_compatible",
            request_id="request-1",
            used_ids=["doc-b"],
        )

        record = db.get(AiGenerationUsageModel, "request-1")
        assert record is not None
        assert record.actor_id == "actor-1"
        assert record.candidate_evidence_ids == ["doc-a", "doc-b"]
        assert record.used_evidence_ids == ["doc-b"]
        assert len(record.context_fingerprint or "") == 64
        assert len(record.output_fingerprint or "") == 64
        assert record.evidence_status == "verified"


def test_used_evidence_must_be_in_the_candidate_set() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[AiGenerationUsageModel.__table__])
    with Session(engine) as db:
        with pytest.raises(ApiError) as exc_info:
            persist_verified_generation_evidence(
                db,
                actor=ActorContext(name="Analyst"),
                candidate_ids=["doc-a"],
                context_payload={"prompt": "매출"},
                mode="query_sql",
                model="gpt-real",
                output_payload={"sql": "SELECT 1"},
                provider="openai_compatible",
                request_id="request-2",
                used_ids=["doc-invented"],
            )
        assert "outside the supplied candidate set" in exc_info.value.message
