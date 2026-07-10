from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel

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
    compression: str | None = None
    storage_path: str | None = None
    target_format: str | None = None
    target_layer: TargetLayer | None = None
    target_path: str | None = None
    transform_output_columns: SourceFieldRows | None = None
    transform_steps: list[TransformStepDraft] | list[dict[str, Any]] | None = None
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
    lineage_graph: dict[str, Any] | None = None
    materialization_runs: list[dict[str, Any]] = Field(default_factory=list)


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
    storage_type: str | None = None
    partition: str | None = None
    compression: str | None = None
    storage_path: str | None = None
    target_dataset: str
    target_database: str | None = None
    target_description: str | None = None
    target_layer: TargetLayer
    target_format: str
    owner: str
    rag: bool = False


class CreatePipelineResponse(CamelModel):
    job: JobRowData
    catalog_target: dict[str, Any] | None = None


class ReviewPipelineRequest(CreatePipelineRequest):
    source_connection_status: Literal["idle", "testing", "success", "failed"] = "idle"


class ReviewEntry(CamelModel):
    label: str
    value: str


class ReviewSchemaRow(CamelModel):
    column_name: str
    nullable: str
    transform: str
    type: str


class ReviewValidationRow(CamelModel):
    label: str
    status: Literal["ready", "warning"]
    value: str


class ReviewSnapshot(CamelModel):
    basic_information: list[ReviewEntry]
    can_create: bool
    destination: list[ReviewEntry]
    permission: list[ReviewEntry]
    schema_: list[ReviewSchemaRow] = Field(alias="schema")
    validation: list[ReviewValidationRow]


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
