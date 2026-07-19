from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Any, Literal, Protocol
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.benchmark import BenchmarkRunModel


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "timed_out", "rejected"}


class BenchmarkExecutionStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    processed_bytes: int | None = Field(default=None, ge=0)
    processed_rows: int | None = Field(default=None, ge=0)
    elapsed_ms: int | None = Field(default=None, ge=0)
    wall_ms: int | None = Field(default=None, ge=0)
    queued_ms: int | None = Field(default=None, ge=0)
    cpu_ms: int | None = Field(default=None, ge=0)
    peak_memory_bytes: int | None = Field(default=None, ge=0)
    spilled_bytes: int | None = Field(default=None, ge=0)
    file_count: int | None = Field(default=None, ge=0)
    partition_count: int | None = Field(default=None, ge=0)
    result_row_count: int | None = Field(default=None, ge=0)
    query_state: str | None = None


class BenchmarkRunRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    idempotency_key: str
    benchmark_suite: str
    suite_version: str
    campaign_id: str
    case_id: str
    candidate_role: Literal["baseline", "candidate"]
    fixture_version: str
    dataset_snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    schema_fingerprint: str
    partition_version: str
    generator_version: str
    prompt_version: str
    model: str
    provider: str
    semantic_context_version: str
    request_id: str | None = None
    sanitized_sql_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    private_sql_reference: str | None = None
    validation_result: dict[str, Any] = Field(default_factory=dict)
    estimate_source: str | None = None
    estimated_bytes: int | None = Field(default=None, ge=0)
    runtime_profile: str
    cache_mode: Literal["cold", "warm"]
    repetition_index: int = Field(ge=0)
    execution_stats: BenchmarkExecutionStats = Field(default_factory=BenchmarkExecutionStats)
    correctness: Literal["pending", "passed", "failed", "not_applicable"] = "pending"
    failure_reason: str | None = None
    regeneration_count: int = Field(default=0, ge=0, le=10)
    status: Literal["pending", "running", "succeeded", "failed", "cancelled", "timed_out", "rejected"]
    query_run_id: str | None = None
    started_at: datetime
    ended_at: datetime | None = None
    expires_at: datetime

    @model_validator(mode="after")
    def terminal_consistency(self) -> "BenchmarkRunRecord":
        if self.status in TERMINAL_STATUSES and self.ended_at is None:
            raise ValueError("terminal benchmark run requires ended_at")
        if self.status not in TERMINAL_STATUSES and self.ended_at is not None:
            raise ValueError("non-terminal benchmark run cannot have ended_at")
        return self


class BenchmarkRunRepository(Protocol):
    def get_by_idempotency_key(self, key: str) -> BenchmarkRunRecord | None: ...
    def get(self, run_id: str) -> BenchmarkRunRecord | None: ...
    def save_new(self, record: BenchmarkRunRecord) -> BenchmarkRunRecord: ...
    def update(self, record: BenchmarkRunRecord) -> BenchmarkRunRecord: ...
    def list_campaign(self, campaign_id: str) -> list[BenchmarkRunRecord]: ...


class SqlAlchemyBenchmarkRunRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_idempotency_key(self, key: str) -> BenchmarkRunRecord | None:
        model = self.db.scalar(select(BenchmarkRunModel).where(BenchmarkRunModel.idempotency_key == key))
        return model_to_record(model)

    def get(self, run_id: str) -> BenchmarkRunRecord | None:
        return model_to_record(self.db.get(BenchmarkRunModel, run_id))

    def save_new(self, record: BenchmarkRunRecord) -> BenchmarkRunRecord:
        self.db.add(record_to_model(record))
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self.get_by_idempotency_key(record.idempotency_key)
            if existing is not None:
                return existing
            raise
        return record

    def update(self, record: BenchmarkRunRecord) -> BenchmarkRunRecord:
        model = self.db.get(BenchmarkRunModel, record.run_id)
        if model is None:
            raise KeyError(record.run_id)
        apply_record(model, record)
        self.db.commit()
        return record

    def list_campaign(self, campaign_id: str) -> list[BenchmarkRunRecord]:
        models = self.db.scalars(
            select(BenchmarkRunModel)
            .where(BenchmarkRunModel.campaign_id == campaign_id)
            .order_by(BenchmarkRunModel.case_id, BenchmarkRunModel.repetition_index, BenchmarkRunModel.id)
        ).all()
        return [record for model in models if (record := model_to_record(model)) is not None]


class InMemoryBenchmarkRunRepository:
    def __init__(self) -> None:
        self.records: dict[str, BenchmarkRunRecord] = {}

    def get_by_idempotency_key(self, key: str) -> BenchmarkRunRecord | None:
        return next((record.model_copy(deep=True) for record in self.records.values() if record.idempotency_key == key), None)

    def get(self, run_id: str) -> BenchmarkRunRecord | None:
        record = self.records.get(run_id)
        return record.model_copy(deep=True) if record else None

    def save_new(self, record: BenchmarkRunRecord) -> BenchmarkRunRecord:
        existing = self.get_by_idempotency_key(record.idempotency_key)
        if existing:
            return existing
        self.records[record.run_id] = record.model_copy(deep=True)
        return record

    def update(self, record: BenchmarkRunRecord) -> BenchmarkRunRecord:
        if record.run_id not in self.records:
            raise KeyError(record.run_id)
        self.records[record.run_id] = record.model_copy(deep=True)
        return record

    def list_campaign(self, campaign_id: str) -> list[BenchmarkRunRecord]:
        return sorted(
            (record.model_copy(deep=True) for record in self.records.values() if record.campaign_id == campaign_id),
            key=lambda record: (record.case_id, record.repetition_index, record.run_id),
        )


class BenchmarkRunService:
    def __init__(self, repository: BenchmarkRunRepository, *, retention_days: int = 30) -> None:
        self.repository = repository
        self.retention_days = retention_days

    def start(self, **values: Any) -> tuple[BenchmarkRunRecord, bool]:
        idempotency_key = str(values["idempotency_key"])
        existing = self.repository.get_by_idempotency_key(idempotency_key)
        if existing:
            fingerprint = record_input_fingerprint(existing)
            proposed = BenchmarkRunRecord.model_validate({
                **existing.model_dump(),
                **values,
                "run_id": existing.run_id,
                "started_at": existing.started_at,
                "expires_at": existing.expires_at,
            })
            if record_input_fingerprint(proposed) != fingerprint:
                raise ValueError("idempotency key already exists with different benchmark inputs")
            return existing, False
        now = datetime.now(timezone.utc)
        record = BenchmarkRunRecord.model_validate({
            **values,
            "run_id": f"bench_{uuid4().hex}",
            "status": "running",
            "started_at": now,
            "ended_at": None,
            "expires_at": now + timedelta(days=self.retention_days),
        })
        return self.repository.save_new(record), True

    def finish(self, run_id: str, *, status: str, **updates: Any) -> BenchmarkRunRecord:
        record = self.repository.get(run_id)
        if record is None:
            raise KeyError(run_id)
        if record.status in TERMINAL_STATUSES:
            return record
        updated = BenchmarkRunRecord.model_validate({
            **record.model_dump(),
            **updates,
            "status": status,
            "ended_at": datetime.now(timezone.utc),
        })
        return self.repository.update(updated)


def record_input_fingerprint(record: BenchmarkRunRecord) -> str:
    keys = (
        "benchmark_suite", "suite_version", "campaign_id", "case_id", "candidate_role",
        "fixture_version", "dataset_snapshot_hash", "generator_version", "prompt_version",
        "model", "provider", "semantic_context_version", "runtime_profile", "cache_mode", "repetition_index",
    )
    payload = {key: getattr(record, key) for key in keys}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def record_to_model(record: BenchmarkRunRecord) -> BenchmarkRunModel:
    model = BenchmarkRunModel(id=record.run_id)
    apply_record(model, record)
    return model


def apply_record(model: BenchmarkRunModel, record: BenchmarkRunRecord) -> None:
    model.idempotency_key = record.idempotency_key
    model.campaign_id = record.campaign_id
    model.case_id = record.case_id
    model.suite_version = record.suite_version
    model.candidate_role = record.candidate_role
    model.status = record.status
    model.repetition_index = record.repetition_index
    model.request_id = record.request_id
    model.query_run_id = record.query_run_id
    model.sanitized_sql_hash = record.sanitized_sql_hash
    model.dataset_snapshot_hash = record.dataset_snapshot_hash
    model.runtime_profile = record.runtime_profile
    model.cache_mode = record.cache_mode
    model.payload = record.model_dump(mode="json")
    model.started_at = record.started_at
    model.ended_at = record.ended_at
    model.expires_at = record.expires_at


def model_to_record(model: BenchmarkRunModel | None) -> BenchmarkRunRecord | None:
    return BenchmarkRunRecord.model_validate(model.payload) if model else None
