from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.benchmarks.run import (
    BenchmarkExecutionStats,
    BenchmarkRunService,
    InMemoryBenchmarkRunRepository,
    SqlAlchemyBenchmarkRunRepository,
)
from app.models.benchmark import BenchmarkRunModel


def run_inputs(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "idempotency_key": "campaign-1:case-1:warm:0",
        "benchmark_suite": "nessie-sql-commerce",
        "suite_version": "1.0.0",
        "campaign_id": "campaign-1",
        "case_id": "case-1",
        "candidate_role": "baseline",
        "fixture_version": "1.0.0",
        "dataset_snapshot_hash": "a" * 64,
        "schema_fingerprint": "schema-v1",
        "partition_version": "month-order-date-v1",
        "generator_version": "query-ai-current",
        "prompt_version": "query-ai-prompt-v1",
        "model": "fixture-model",
        "provider": "fixture",
        "semantic_context_version": "semantic-v1",
        "runtime_profile": "local-trino-482-minio-bounded-v1",
        "cache_mode": "warm",
        "repetition_index": 0,
    }
    values.update(overrides)
    return values


def test_service_is_idempotent_and_terminal_receipt_is_immutable() -> None:
    repository = InMemoryBenchmarkRunRepository()
    service = BenchmarkRunService(repository)
    first, created = service.start(**run_inputs())
    same, created_again = service.start(**run_inputs())

    assert created is True
    assert created_again is False
    assert same.run_id == first.run_id

    finished = service.finish(
        first.run_id,
        status="succeeded",
        correctness="passed",
        execution_stats=BenchmarkExecutionStats(processed_bytes=100, result_row_count=1),
    )
    repeated = service.finish(first.run_id, status="failed", failure_reason="must not overwrite")
    assert repeated.status == "succeeded"
    assert repeated.failure_reason is None
    assert finished.expires_at > datetime.now(timezone.utc)


def test_idempotency_key_rejects_different_inputs() -> None:
    service = BenchmarkRunService(InMemoryBenchmarkRunRepository())
    service.start(**run_inputs())
    with pytest.raises(ValueError, match="different benchmark inputs"):
        service.start(**run_inputs(case_id="other"))


def test_sqlalchemy_repository_uses_same_contract() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    BenchmarkRunModel.__table__.create(engine)
    with Session(engine) as db:
        service = BenchmarkRunService(SqlAlchemyBenchmarkRunRepository(db))
        record, _ = service.start(**run_inputs())
        saved = service.finish(record.run_id, status="rejected", correctness="not_applicable", failure_reason="expected")
        listed = SqlAlchemyBenchmarkRunRepository(db).list_campaign("campaign-1")

    assert saved.status == "rejected"
    assert len(listed) == 1
    assert listed[0].failure_reason == "expected"
