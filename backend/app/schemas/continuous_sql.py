from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import Field, computed_field, field_validator, model_validator

from app.schemas.common import CamelModel
from app.schemas.iceberg import IcebergWriterTarget

ContinuousSqlStaticBindingPolicy = Literal["PINNED_AT_START", "LATEST_PER_BATCH"]
ContinuousSqlServingMode = Literal["iceberg", "clickhouse"]
CONTINUOUS_SQL_DEFAULT_TRIGGER_SECONDS = 10
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
ContinuousSqlDependencyInputType = Literal["realtime", "batch", "static"]
ContinuousSqlDependencyExecutionPolicy = Literal["run_on_tree_start", "reuse_snapshot"]
ContinuousSqlRefreshStatus = Literal[
    "idle",
    "running",
    "failed",
    "catalog_ready",
    "dashboard_ready",
]


class ClickHouseWriterTarget(CamelModel):
    engine: Literal["clickhouse"] = "clickhouse"
    database: str = Field(min_length=1, max_length=128)
    table: str = Field(min_length=1, max_length=128)

    @field_validator("database", "table")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", normalized) is None:
            raise ValueError(
                "ClickHouse target identifiers may contain letters, numbers, and underscores and cannot start with a number"
            )
        return normalized

    @computed_field(alias="tableUri", return_type=str)
    @property
    def table_uri(self) -> str:
        return f"clickhouse://{self.database}/{self.table}"


class ContinuousSqlOutput(CamelModel):
    dataset_id: str = Field(min_length=1, max_length=160)
    dataset_name: str = Field(min_length=1, max_length=255)
    layer: Literal["SILVER", "GOLD"] = "GOLD"
    serving_mode: ContinuousSqlServingMode = "iceberg"
    storage_path: str | None = Field(default=None, min_length=1, max_length=2048)
    iceberg_target: IcebergWriterTarget | None = None
    clickhouse_target: ClickHouseWriterTarget | None = None

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
            if (self.storage_path is None) != (self.iceberg_target is None):
                raise ValueError(
                    "Iceberg Continuous SQL output must provide both storagePath and icebergTarget or let the backend derive both"
                )
            if self.iceberg_target is not None and self.iceberg_target.write_mode != "append":
                raise ValueError("Continuous SQL output requires an append Iceberg target")
            if self.clickhouse_target is not None:
                raise ValueError("Iceberg Continuous SQL output cannot include clickhouseTarget")
            return self
        if self.clickhouse_target is None:
            raise ValueError("ClickHouse Continuous SQL output requires clickhouseTarget")
        if self.iceberg_target is not None:
            raise ValueError("ClickHouse Continuous SQL output cannot include icebergTarget")
        if self.storage_path is not None:
            raise ValueError("ClickHouse Continuous SQL output cannot include storagePath")
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
    baseline_dataset_id: str | None = Field(default=None, min_length=1, max_length=160)

    @field_validator("checkpoint_path")
    @classmethod
    def validate_checkpoint_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().rstrip("/")
        if not normalized.startswith(("s3://", "s3a://")):
            raise ValueError("Continuous SQL checkpointPath must use s3:// or s3a://")
        return normalized

    @model_validator(mode="after")
    def reject_clickhouse_checkpoint(self) -> "ContinuousSqlCreateRequest":
        if self.output.serving_mode == "clickhouse" and self.checkpoint_path is not None:
            raise ValueError("ClickHouse Continuous SQL does not accept checkpointPath")
        if self.baseline_dataset_id is not None:
            if self.output.serving_mode != "iceberg":
                raise ValueError("Incremental baseline binding requires Iceberg serving")
            if self.baseline_dataset_id != self.output.dataset_id:
                raise ValueError("baselineDatasetId must equal output.datasetId")
        return self


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
    producer_job_id: str | None = None
    producer_job_kind: str | None = None
    execution_mode: str | None = None
    source_kind: str | None = None
    runtime_status: str | None = None
    broadcast_hint: bool = False
    cache_hint: bool = False


class ContinuousSqlDependencyBinding(CamelModel):
    sql_job_id: str | None = None
    input_dataset_id: str
    child_job_id: str | None = None
    input_type: ContinuousSqlDependencyInputType
    execution_policy: ContinuousSqlDependencyExecutionPolicy
    required: bool = True

    @model_validator(mode="after")
    def validate_execution_ownership(self) -> "ContinuousSqlDependencyBinding":
        if self.input_type == "realtime" and not self.child_job_id:
            raise ValueError("Realtime Continuous SQL dependency requires childJobId")
        if self.child_job_id is None and self.execution_policy != "reuse_snapshot":
            raise ValueError("Jobless static dependency requires reuse_snapshot policy")
        if self.child_job_id is not None and self.execution_policy != "run_on_tree_start":
            raise ValueError("Producer dependency requires run_on_tree_start policy")
        return self


class ContinuousSqlRevisionInput(CamelModel):
    """One producer Dataset in the private revision-transform runner payload."""

    input_dataset_id: str
    input_type: ContinuousSqlDependencyInputType
    child_job_id: str | None = None
    execution_policy: ContinuousSqlDependencyExecutionPolicy
    required: bool = True
    revision: int | None = None
    snapshot_id: str | None = None


class ContinuousSqlRevisionTransformRequest(CamelModel):
    """Private worker contract for a Dataset-revision SQL tree run.

    This model deliberately excludes Kafka broker, topic, consumer group, and
    offset fields.  Those belong only to the producer child Job.
    """

    execution_input_mode: Literal["dataset_revision"] = "dataset_revision"
    tree_run_id: str
    tree_fencing_token: str
    sql_job_id: str
    continuous_sql_run_id: str
    run_generation: int
    input_datasets: list[ContinuousSqlRevisionInput] = Field(default_factory=list)
    static_bindings: list[dict[str, Any]] = Field(default_factory=list)
    output_dataset_id: str
    output_target: dict[str, Any]


class ContinuousSqlPlanResponse(CamelModel):
    normalized_sql: str
    plan_version: str
    plan_hash: str
    runtime_sql: str
    relations: list[ContinuousSqlRelationBinding]
    dependency_bindings: list[ContinuousSqlDependencyBinding] = Field(default_factory=list)
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


class ContinuousSqlTreeJobLock(CamelModel):
    job_id: str
    node_run_id: str
    lock_kind: Literal["parent", "child"]
    generation: int
    fencing_token_hash: str
    lease_expires_at: str
    active: bool


class ContinuousSqlTreeNodeRun(CamelModel):
    node_run_id: str
    tree_run_id: str
    job_id: str
    node_type: Literal["parent", "realtime", "batch"]
    trigger_type: Literal["parent_tree", "standalone"]
    parent_run_id: str | None = None
    producer_run_id: str | None = None
    status: str
    input_dataset_revisions: dict[str, int] = Field(default_factory=dict)
    started_at: str
    ended_at: str | None = None


class ContinuousSqlTreeRun(CamelModel):
    tree_run_id: str
    sql_job_id: str
    continuous_sql_run_id: str | None = None
    generation: int
    trigger_type: Literal["parent_tree", "standalone"]
    status: str
    fencing_token_hash: str
    lease_expires_at: str
    input_dataset_revisions: dict[str, int] = Field(default_factory=dict)
    nodes: list[ContinuousSqlTreeNodeRun] = Field(default_factory=list)
    locks: list[ContinuousSqlTreeJobLock] = Field(default_factory=list)
    started_at: str
    ended_at: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None


class ContinuousSqlExecutionTree(CamelModel):
    sql_job_id: str
    active_tree_run_id: str | None = None
    locked_job_ids: list[str] = Field(default_factory=list)
    lock_conflict: dict[str, Any] | None = None


class ContinuousSqlRefreshState(CamelModel):
    latest_source_revision: int = 0
    processing_source_revision: int | None = None
    published_source_revision: int = 0
    status: ContinuousSqlRefreshStatus = "idle"
    last_error: str | None = None


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
    dependency_bindings: list[ContinuousSqlDependencyBinding] = Field(default_factory=list)
    execution_tree: ContinuousSqlExecutionTree | None = None
    active_tree_run: ContinuousSqlTreeRun | None = None
    static_binding_policy: ContinuousSqlStaticBindingPolicy
    trigger_interval_seconds: int
    serving_mode: ContinuousSqlServingMode = "iceberg"
    checkpoint_path: str
    output_dataset_id: str
    output_dataset_name: str
    output_layer: Literal["SILVER", "GOLD"]
    output_storage_path: str
    output_target: IcebergWriterTarget | ClickHouseWriterTarget
    desired_state: ContinuousSqlDesiredState
    observed_state: ContinuousSqlObservedState
    generation: int
    active_run_id: str | None = None
    worker_id: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None
    active_run: ContinuousSqlRun | None = None
    incremental_binding: dict[str, Any] | None = None
    refresh_state: ContinuousSqlRefreshState = Field(default_factory=ContinuousSqlRefreshState)


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
    value: dict[str, Any] | IcebergWriterTarget | ClickHouseWriterTarget,
) -> IcebergWriterTarget | ClickHouseWriterTarget:
    if isinstance(value, (IcebergWriterTarget, ClickHouseWriterTarget)):
        return value
    if str(value.get("engine") or "").strip().casefold() == "clickhouse":
        return ClickHouseWriterTarget.model_validate(value)
    return IcebergWriterTarget.model_validate(value)


def continuous_sql_serving_mode(value: Any) -> ContinuousSqlServingMode:
    target = value.output_target if hasattr(value, "output_target") else value
    if isinstance(target, ClickHouseWriterTarget):
        return "clickhouse"
    if isinstance(target, dict) and str(target.get("engine") or "").strip().casefold() == "clickhouse":
        return "clickhouse"
    return "iceberg"
