from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from app.schemas.common import CamelModel
from app.schemas.iceberg import IcebergWriterTarget

ContinuousSqlStaticBindingPolicy = Literal["PINNED_AT_START", "LATEST_PER_BATCH"]
ContinuousSqlServingMode = Literal["iceberg"]
CONTINUOUS_SQL_DEFAULT_TRIGGER_SECONDS = 5
ContinuousSqlDesiredState = Literal["stopped", "running", "paused"]
ContinuousSqlObservedState = Literal[
    "starting",
    "running",
    "pausing",
    "paused",
    "stopping",
    "stopped",
    "failed",
    "recovering",
]
ContinuousSqlBatchStage = Literal[
    "planned",
    "executing",
    "output_committed",
    "catalog_ready",
    "dashboard_ready",
    "failed",
]
ContinuousSqlCommand = Literal["start", "pause", "resume", "stop", "recover"]


class ContinuousSqlOutput(CamelModel):
    dataset_id: str = Field(min_length=1, max_length=160)
    dataset_name: str = Field(min_length=1, max_length=255)
    layer: Literal["SILVER", "GOLD"] = "GOLD"
    serving_mode: ContinuousSqlServingMode = "iceberg"
    storage_path: str | None = Field(default=None, min_length=1, max_length=2048)
    iceberg_target: IcebergWriterTarget | None = None

    @field_validator("storage_path")
    @classmethod
    def validate_storage_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().rstrip("/")
        if not normalized.startswith(("s3://", "s3a://")):
            raise ValueError("Continuous SQL storagePath must use s3:// or s3a://")
        if any(character in normalized for character in ("\x00", "\r", "\n")):
            raise ValueError("Continuous SQL storagePath is invalid")
        return normalized

    @model_validator(mode="after")
    def require_mode_target(self) -> "ContinuousSqlOutput":
        if self.serving_mode == "iceberg":
            if self.storage_path is None or self.iceberg_target is None:
                raise ValueError(
                    "Iceberg Continuous SQL output requires storagePath and icebergTarget"
                )
            if self.iceberg_target.write_mode != "append":
                raise ValueError("Continuous SQL output requires an append Iceberg target")
        return self


class ContinuousSqlPlanRequest(CamelModel):
    query: str = Field(min_length=1, max_length=100_000)
    relation_dataset_ids: list[str] = Field(min_length=2, max_length=100)
    static_binding_policy: ContinuousSqlStaticBindingPolicy = "PINNED_AT_START"
    trigger_interval_seconds: int = Field(
        default=CONTINUOUS_SQL_DEFAULT_TRIGGER_SECONDS,
        ge=1,
        le=3600,
    )

    @field_validator("relation_dataset_ids")
    @classmethod
    def unique_relation_dataset_ids(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for item in value:
            dataset_id = str(item or "").strip()
            if dataset_id and dataset_id not in normalized:
                normalized.append(dataset_id)
        if len(normalized) < 2:
            raise ValueError("Continuous SQL requires at least two distinct relation datasets")
        return normalized


class ContinuousSqlCreateRequest(ContinuousSqlPlanRequest):
    name: str = Field(min_length=1, max_length=255)
    output: ContinuousSqlOutput
    checkpoint_path: str | None = Field(default=None, max_length=2048)
    client_request_id: str | None = Field(default=None, max_length=160)

    @field_validator("checkpoint_path")
    @classmethod
    def validate_checkpoint_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().rstrip("/")
        if not normalized.startswith(("s3://", "s3a://")):
            raise ValueError("Continuous SQL checkpointPath must use s3:// or s3a://")
        return normalized

class ContinuousSqlRelationBinding(CamelModel):
    alias: str
    dataset_id: str
    dataset_name: str
    mode: Literal["streaming", "static"]
    query_engine_table: dict[str, Any]
    runtime_view: str = ""
    schema_: list[list[str]] = Field(default_factory=list, alias="schema")
    referenced_columns: list[str] = Field(default_factory=list)
    schema_fingerprint: str
    snapshot_id: str | None = None
    streaming_source: dict[str, Any] | None = None
    unique_key_sets: list[list[str]] = Field(default_factory=list)
    estimated_row_count: int | None = None
    broadcast_hint: bool = False
    cache_hint: bool = False


class ContinuousSqlPlanResponse(CamelModel):
    normalized_sql: str
    plan_version: str
    plan_hash: str
    runtime_sql: str
    relations: list[ContinuousSqlRelationBinding]
    joins: list[dict[str, Any]]
    output_schema: list[list[str]]
    static_binding_policy: ContinuousSqlStaticBindingPolicy
    warnings: list[dict[str, Any]] = Field(default_factory=list)
    compiled_plan: dict[str, Any]


class ContinuousSqlRun(CamelModel):
    run_id: str
    job_id: str
    generation: int
    fencing_token_hash: str
    plan_hash: str
    status: ContinuousSqlObservedState
    static_bindings: list[dict[str, Any]] = Field(default_factory=list)
    checkpoint_path: str
    worker_id: str | None = None
    started_at: str
    ended_at: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None


class ContinuousSqlBatch(CamelModel):
    batch_id: int
    job_id: str
    run_id: str
    generation: int
    stage: ContinuousSqlBatchStage
    plan_hash: str
    input_offsets: list[dict[str, Any]] = Field(default_factory=list)
    static_snapshots: list[dict[str, Any]] = Field(default_factory=list)
    source_boundary: dict[str, Any] = Field(default_factory=dict)
    output_commit: dict[str, Any] | None = None
    output_commit_id: str | None = None
    manifest_path: str | None = None
    row_count: int = 0
    dataset_revision: int | None = None
    published_at: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None


class ContinuousSqlJob(CamelModel):
    id: str
    name: str
    owner: str
    created_by: str
    original_sql: str
    normalized_sql: str
    plan_version: str
    plan_hash: str
    compiled_plan: dict[str, Any]
    relation_bindings: list[ContinuousSqlRelationBinding]
    static_binding_policy: ContinuousSqlStaticBindingPolicy
    trigger_interval_seconds: int
    serving_mode: ContinuousSqlServingMode = "iceberg"
    checkpoint_path: str
    output_dataset_id: str
    output_dataset_name: str
    output_layer: Literal["SILVER", "GOLD"]
    output_storage_path: str
    output_target: IcebergWriterTarget
    desired_state: ContinuousSqlDesiredState
    observed_state: ContinuousSqlObservedState
    generation: int
    active_run_id: str | None = None
    worker_id: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None
    active_run: ContinuousSqlRun | None = None


class ContinuousSqlCommandRequest(CamelModel):
    command: ContinuousSqlCommand
    command_id: str = Field(min_length=1, max_length=160)


class ContinuousSqlCommandResponse(CamelModel):
    command: ContinuousSqlCommand
    command_id: str
    idempotent_replay: bool = False
    job: ContinuousSqlJob


class ContinuousSqlJobList(CamelModel):
    jobs: list[ContinuousSqlJob] = Field(default_factory=list)


def continuous_sql_target(
    value: dict[str, Any] | IcebergWriterTarget,
) -> IcebergWriterTarget:
    if isinstance(value, IcebergWriterTarget):
        return value
    return IcebergWriterTarget.model_validate(value)


def continuous_sql_serving_mode(value: Any) -> ContinuousSqlServingMode:
    del value
    return "iceberg"
