from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.permissions import PermissionGrant, ResourcePermissions
from app.schemas.text_structuring import TextStructuringSpecRef

TargetLayer = Literal["RAW", "BRONZE", "SILVER", "GOLD"]
JobStatus = Literal["scheduled", "failed", "running", "paused", "canceled", "stopped"]
JobRunStatus = Literal["queued", "running", "success", "failed", "canceled"]
JobDagStepStatus = Literal["pending", "running", "success", "failed", "blocked"]
JobCommand = Literal["run", "retry", "pause", "cancelRun", "stopSchedule"]

SourceFieldRows = list[tuple[str, str]]


class JobProgress(CamelModel):
    label: str
    value: int


class JobStats(CamelModel):
    average_duration: str
    current_stage: str
    input_rows: str
    last_synced_at: str | None = None
    last_success: str
    output_rows: str
    output_path: str | None = None
    sample_scope: str
    schema_columns: str
    source_units: str
    success_rate: str
    total_runs: str


class SchemaColumnDraft(CamelModel):
    confidence: int | None = None
    included: bool = True
    nullable: bool = False
    role: str | None = None
    source_name: str
    target_name: str
    type: str


class TransformStepDraft(CamelModel):
    enabled: bool = True
    id: str
    input: str
    kind: str
    label: str
    on_error: str
    operation: str
    output: str
    params: str = ""


class QualityRuleDraft(CamelModel):
    enabled: bool = True
    failure_action: str
    id: str
    kind: str
    severity: str
    target_column: str
    validation_type: str


class RetryPolicyDraft(CamelModel):
    backoff_multiplier: float = 2
    backoff_strategy: str = "exponential"
    failure_action: str
    initial_retry_delay_minutes: int = 1
    max_retries: int
    max_retry_delay_minutes: int = 30
    retry_interval_minutes: int = 1
    timeout_minutes: int


class WatermarkPolicyDraft(CamelModel):
    column: str = "updated_at"
    enabled: bool = True
    lookback_minutes: int = 5
    mode: str = "last_success_to_scheduled_at"


class JobRunSummary(CamelModel):
    airflow_dag_id: str | None = None
    airflow_dag_run_id: str | None = None
    airflow_run_url: str | None = None
    airflow_state: str | None = None
    duration: str
    ended_at: str
    error_summary: str
    failed_stage: str
    input_rows: str
    output_rows: str
    output_path: str | None = None
    run_id: str
    started_at: str
    status: JobRunStatus
    sync_error: str | None = None
    task_states: dict[str, Any] | None = None


class JobDagStep(CamelModel):
    details: SourceFieldRows | None = None
    id: str
    logs: list[str] | None = None
    meta: str
    note: str | None = None
    status: JobDagStepStatus
    title: str


class JobRowData(CamelModel):
    status: JobStatus
    name: str
    id: str
    owner: str
    created_by: str | None = None
    created_by_profile: dict[str, Any] | None = None
    permission_grants: list[PermissionGrant] = Field(default_factory=list)
    permissions: ResourcePermissions = Field(default_factory=ResourcePermissions)
    tag: str
    source: str
    target: str
    schedule: str
    schedule_policy: dict[str, Any] | None = None
    schedule_summary: str | None = None
    source_config: SourceFieldRows | None = None
    source_label: str | None = None
    source_type: str | None = None
    retry_policy: RetryPolicyDraft | dict[str, Any] | None = None
    retry_policy_summary: str | None = None
    run_limit_summary: str | None = None
    permission_roles: list[dict[str, Any]] | None = None
    storage_type: str | None = None
    partition: str | None = None
    partition_columns: list[str] | None = None
    index_columns: list[str] | None = None
    compression: str | None = None
    storage_path: str | None = None
    target_description: str | None = None
    target_tags: list[str] | None = None
    target_format: str | None = None
    target_layer: TargetLayer | None = None
    target_path: str | None = None
    transform_output_columns: SourceFieldRows | None = None
    transform_steps: list[TransformStepDraft] | list[dict[str, Any]] | None = None
    text_structuring_spec_ref: TextStructuringSpecRef | None = None
    text_structuring_definition_snapshot: dict[str, Any] | None = None
    quality_invalid_rows: list[list[str]] | None = None
    quality_rules: list[QualityRuleDraft] | list[dict[str, Any]] | None = None
    quality_score: float | None = None
    quality_status: str | None = None
    last_run: str
    last_state: str
    next_run: str
    progress: JobProgress | dict[str, Any] | None = None
    stats: JobStats | dict[str, Any] | None = None
    run_history: list[JobRunSummary] | list[dict[str, Any]] | None = None
    dag_steps: list[JobDagStep] | list[dict[str, Any]] | None = None
    dag_steps_by_run_id: dict[str, list[JobDagStep] | list[dict[str, Any]]] | None = None


class CatalogDataset(CamelModel):
    id: str
    name: str
    description: str
    owner: str
    created_by: str | None = None
    created_by_profile: dict[str, Any] | None = None
    permission_grants: list[PermissionGrant] = Field(default_factory=list)
    permissions: ResourcePermissions = Field(default_factory=ResourcePermissions)
    layer: TargetLayer
    status: Literal["available", "approval_required"]
    freshness: Literal["latest", "stale", "approval"]
    source: str
    rows: str
    size: str
    quality: str
    last_updated: str
    next_refresh: str
    rag: bool
    tags: list[str]
    schema_: SourceFieldRows = Field(alias="schema")
    sample_rows: list[list[str]]
    upstream: list[str]
    downstream: list[str]
    source_run_id: str | None = None
    storage_format: str | None = None
    storage_location: str | None = None
    storage_size_bytes: int | None = None
    partition: str | None = None
    partition_columns: list[str] | None = None
    index_columns: list[str] | None = None
    lineage_graph: dict[str, Any] | None = None
    materialization_runs: list[dict[str, Any]] = Field(default_factory=list)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    text_structuring: dict[str, Any] | None = None
    parent_dataset_id: str | None = None
    artifact_kind: str | None = None


class DerivedDatasetSpec(CamelModel):
    description: str
    layer: Literal["SILVER", "GOLD"]
    name: str
    rag: bool = False
    refresh_policy: Literal["manual"] = "manual"
    tags: list[str] = Field(default_factory=list)


class CreateDerivedDatasetRequest(CamelModel):
    dataset: DerivedDatasetSpec
    preview_limit: int | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    source_dataset_id: str
    source_run_id: str
    validation_key: str | None = None


class CreatePipelineRequest(CamelModel):
    id: str
    job_name: str
    schema_columns: list[SchemaColumnDraft] = Field(default_factory=list)
    schema_fingerprint: str | None = None
    schema_sample_rows: list[list[str]] = Field(default_factory=list)
    source_config: SourceFieldRows = Field(default_factory=list)
    source_type: str
    source_label: str
    schema_summary: str = ""
    rule_summary: str = ""
    transform_output_columns: SourceFieldRows = Field(default_factory=list)
    transform_steps: list[TransformStepDraft] = Field(default_factory=list)
    text_structuring_spec_ref: TextStructuringSpecRef | None = None
    quality_invalid_rows: list[list[str]] = Field(default_factory=list)
    quality_rules: list[QualityRuleDraft] = Field(default_factory=list)
    quality_score: float | None = None
    quality_status: str = "idle"
    schedule_label: str
    schedule_summary: str | None = None
    retry_policy: RetryPolicyDraft | None = None
    retry_policy_summary: str = ""
    run_limit_summary: str = ""
    start_date: str | None = None
    end_date: str | None = None
    next_run_utc: str | None = None
    overlap_policy: str | None = None
    timezone: str | None = None
    watermark_policy: WatermarkPolicyDraft | dict[str, Any] | None = None
    permission_summary: str = ""
    permission_roles: list[dict[str, Any]] | None = None
    permission_grants: list[PermissionGrant] | None = None
    created_by: str | None = None
    created_by_profile: dict[str, Any] | None = None
    storage_type: str | None = None
    partition: str | None = None
    partition_columns: list[str] | None = None
    index_columns: list[str] | None = None
    compression: str | None = None
    storage_path: str | None = None
    target_dataset: str
    target_description: str | None = None
    target_tags: list[str] = Field(default_factory=list)
    target_layer: TargetLayer
    target_format: str
    owner: str
    rag: bool = False


class CreatePipelineResponse(CamelModel):
    job: JobRowData
    catalog_target: dict[str, Any] | None = None


class JobCommandRequest(CamelModel):
    command: JobCommand


class JobCommandResponse(CamelModel):
    action: str
    api_path: str
    dataset: CatalogDataset | None = None
    job: JobRowData | None = None
    run: JobRunSummary | None = None
    dag_steps: list[JobDagStep] | None = None
    processing_result: dict[str, Any] | None = None


class InternalSparkExecutionRequest(CamelModel):
    command: Literal["run", "retry"] = "run"


class ScheduledJobRunRequest(CamelModel):
    force: bool = False
    job_id: str | None = None
    kafka_only: bool = True


class ScheduledJobRunItem(CamelModel):
    job_id: str
    job_name: str
    reason: str
    response: JobCommandResponse | None = None
    schedule: str
    triggered: bool


class ScheduledJobRunResponse(CamelModel):
    checked_count: int
    items: list[ScheduledJobRunItem]
    triggered_count: int


class KafkaReviewIngestRequest(CamelModel):
    allow_empty: bool = False
    broker: str = "127.0.0.1:19092"
    topic: str = "reviews.raw"
    consumer_group_id: str | None = None
    dataset_id: str | None = None
    dataset_name: str = "reviews_raw"
    landing_bucket: str = "m3-raw"
    landing_endpoint: str = "http://127.0.0.1:19000"
    landing_prefix: str = "kafka-landing"
    local_landing_dir: str | None = None
    max_messages: int = Field(default=100, ge=1, le=1_000_000)
    offset_policy: Literal["earliest", "latest"] = "earliest"
    register_catalog: bool = True
    run_id: str | None = None
    storage_mode: Literal["local", "s3"] = "s3"
    timeout_ms: int = Field(default=10000, ge=1000, le=300000)


class KafkaReviewIngestResponse(CamelModel):
    broker: str
    catalog_dataset: dict[str, Any] | None = None
    consumed_count: int
    dataset_id: str | None = None
    dataset_name: str | None = None
    failed_count: int
    metadata_location: str
    run_id: str
    status: Literal["success"]
    storage_format: str
    storage_location: str
    storage_mode: Literal["local", "s3"]
    stored_count: int
    topic: str


class QueryRunRequest(CamelModel):
    dataset_id: str
    query: str


class QueryRunResponse(CamelModel):
    columns: list[str]
    dataset_id: str
    dataset_name: str
    executed_at: str
    query: str
    row_count: int
    rows: list[list[str]]
    run_id: str


class SchemaDraft(CamelModel):
    columns: list[SchemaColumnDraft]
    sample_rows: list[list[str]]
    schema_fingerprint: str | None = None
    summary: str


class SourceDraft(CamelModel):
    connection_message: str | None = None
    connection_status: Literal["idle", "testing", "success", "failed"]
    source_config: SourceFieldRows
    source_label: str
    source_type: str


class DraftPipelinePatch(CamelModel):
    schema_: SchemaDraft | None = Field(default=None, alias="schema")
    source: SourceDraft | None = None


class SourceConnectorRequest(CamelModel):
    source_config: SourceFieldRows = Field(default_factory=list)
    source_type: str


class SourceAssetsRequest(CamelModel):
    prefix: str = ""
    source_config: SourceFieldRows = Field(default_factory=list)
    source_type: str


class SourceAssetsResponse(CamelModel):
    assets: list[tuple[str, str, str]]
    count: int | None = None
    limit: int | None = None
    prefix: str


class SourceConnectorAnalysis(CamelModel):
    action_path: str
    assets: list[tuple[str, str, str]]
    draft_patch: DraftPipelinePatch
    logs: list[str]
    message: str
    preview_columns: list[str]
    preview_note: str
    preview_rows: list[list[str]]
    status: Literal["idle", "testing", "success", "failed"]
    test_items: list[tuple[str, str]]
