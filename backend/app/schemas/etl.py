import os
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.schemas.common import CamelModel, to_camel
from app.schemas.iceberg import IcebergWriterTarget
from app.schemas.permissions import PermissionAction, PermissionGrant, ResourcePermissions

TargetLayer = Literal["RAW", "BRONZE", "SILVER", "GOLD"]
JobStatus = Literal["scheduled", "failed", "running", "paused", "canceled", "stopped"]
JobScheduleKind = Literal["daily", "weekly", "monthly", "realtime", "none", "other"]
JobRunStatus = Literal["queued", "running", "success", "failed", "canceled"]
JobRunOutcome = Literal["success", "failed", "canceled"]
JobDagStepStatus = Literal["pending", "running", "success", "failed", "blocked"]
JobKind = Literal["pipeline", "trino_sql_materialization"]
KafkaExecutionMode = Literal["snapshot", "continuous"]
RuleContractVersion = Literal["1.0"]
CanonicalRuleKind = Literal["transform", "quality"]
CanonicalRuleErrorPolicy = Literal["fail_batch", "quarantine", "warn"]
CanonicalRuleFailureDisposition = Literal["keep", "drop_row", "set_null"]
ContinuousRuntimeStatus = Literal["starting", "running", "pausing", "paused", "stopping", "stopped", "failed"]
JobCommand = Literal["run", "retry", "pause", "cancelRun", "stopSchedule", "resumeSchedule", "startContinuous", "pauseContinuous", "resumeContinuous", "stopContinuous"]

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
    source_type: str | None = None
    target_name: str
    type: str


class RecordParsingColumnDraft(CamelModel):
    position: int = Field(ge=0, le=999)
    name: str
    inferred_type: Literal["String", "Integer", "Float", "Boolean", "Timestamp"] = "String"


class RecordParsingDraft(CamelModel):
    enabled: bool = False
    delimiter_kind: Literal["whitespace"] = "whitespace"
    delimiter_pattern: Literal["\\s+"] = "\\s+"
    header: bool = False
    expected_field_count: int = Field(default=0, ge=0, le=1000)
    columns: list[RecordParsingColumnDraft] = Field(default_factory=list)


class RecordParsingInvalidRow(CamelModel):
    line_number: int
    expected_field_count: int
    actual_field_count: int
    raw_preview: str


class RecordParsingPreviewRequest(CamelModel):
    raw_lines: list[str] = Field(default_factory=list, max_length=500)
    record_parsing: RecordParsingDraft


class RecordParsingPreviewResponse(CamelModel):
    can_apply: bool
    columns: list[SchemaColumnDraft]
    sample_rows: list[list[str]]
    record_parsing: RecordParsingDraft
    total_rows: int
    valid_rows: int
    invalid_rows: list[RecordParsingInvalidRow]


class TransformStepDraft(CamelModel):
    canonical_parameters: dict[str, Any] | None = None
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
    canonical_parameters: dict[str, Any] | None = None
    enabled: bool = True
    failure_action: str
    id: str
    kind: str
    params: str = ""
    severity: str
    target_column: str
    validation_type: str


class CanonicalRuleDraft(CamelModel):
    contract_version: str = "1.0"
    enabled: bool = True
    failure_disposition: str = "keep"
    id: str
    input_columns: list[str] = Field(default_factory=list)
    kind: str
    label: str | None = None
    on_error: str = "warn"
    operation: str
    output_columns: list[str] = Field(default_factory=list)
    output_type: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    severity: str | None = None


class RuleCompilationIssue(CamelModel):
    code: str
    field: str | None = None
    message: str
    rule_id: str | None = None


class RuleCompilationResult(CamelModel):
    contract_version: RuleContractVersion = "1.0"
    issues: list[RuleCompilationIssue] = Field(default_factory=list)
    output_schema: SourceFieldRows = Field(default_factory=list)
    rules: list[CanonicalRuleDraft] = Field(default_factory=list)
    status: Literal["pass", "fail"] = "pass"


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


class KafkaSchemaEvolutionPolicy(CamelModel):
    additive_nullable: Literal["allow", "quarantine", "pause"] = "allow"
    missing_required: Literal["quarantine", "pause"] = "quarantine"
    incompatible_type: Literal["quarantine", "pause"] = "quarantine"
    unknown_field: Literal["preserve", "ignore", "quarantine", "pause"] = "preserve"


class KafkaContinuousConfigDraft(CamelModel):
    initial_offset_policy: Literal["earliest", "latest"] = "earliest"
    trigger_interval_seconds: int = Field(default=30, ge=1, le=3600)
    max_offsets_per_trigger: int = Field(default=10000, ge=1, le=1_000_000)
    schema_evolution_policy: KafkaSchemaEvolutionPolicy = Field(default_factory=KafkaSchemaEvolutionPolicy)


class KafkaContinuousRuntime(CamelModel):
    status: ContinuousRuntimeStatus
    checkpoint_path: str
    heartbeat_at: str | None = None
    last_flush_at: str | None = None
    last_batch_id: str | None = None
    lag: int | None = None
    max_partition_lag: int | None = None
    lagging_partition_count: int = 0
    lag_available: bool = False
    partition_progress: dict[str, dict[str, int]] = Field(default_factory=dict)
    last_batch_duration_ms: int | None = None
    last_batch_input_rows: int = 0
    throughput_rows_per_second: float | None = None
    schema_version: int = 1
    schema_fingerprint: str | None = None
    schema_status: str = "stable"
    schema_changes: list[dict[str, Any]] = Field(default_factory=list)
    rule_contract_version: str = "1.0"
    rule_fingerprint: str | None = None
    runtime_fingerprint: str | None = None
    rule_metrics: dict[str, int] = Field(default_factory=dict)
    last_rule_result: dict[str, Any] = Field(default_factory=dict)
    consumed_count: int = 0
    stored_count: int = 0
    quarantined_count: int = 0
    replayed_count: int = 0
    failed_count: int = 0
    last_error: str | None = None


class ContinuousWorkerLogsResponse(CamelModel):
    job_id: str
    container_state: str
    lines: list[str] = Field(default_factory=list)
    truncated: bool = False


class KafkaContinuousSession(CamelModel):
    session_id: str
    job_id: str
    worker_attempt_id: str | None = None
    status: Literal["starting", "running", "stopping", "stopped", "failed"]
    started_at: str
    ended_at: str | None = None
    end_reason: str | None = None
    consumed_count: int = 0
    stored_count: int = 0
    quarantined_count: int = 0
    failed_count: int = 0
    last_batch_id: str | None = None
    last_flush_at: str | None = None
    lag: int | None = None
    checkpoint_path: str
    last_error: str | None = None
    dag_steps: list[dict[str, Any]] = Field(default_factory=list)


class KafkaContinuousBatch(CamelModel):
    batch_id: int
    session_id: str
    status: Literal["running", "success", "failed"] = "success"
    published_at: str | None = None
    consumed_count: int = 0
    stored_count: int = 0
    quarantined_count: int = 0
    duration_ms: int | None = None
    source_ranges: list[dict[str, Any]] = Field(default_factory=list)
    source_boundary: dict[str, Any] = Field(default_factory=dict)
    data_path: str | None = None
    iceberg_snapshot_id: str | None = None
    iceberg_table_uri: str | None = None
    quarantine_path: str | None = None
    manifest_path: str | None = None
    last_error: str | None = None
    dag_steps: list[dict[str, Any]] = Field(default_factory=list)


class ContinuousQuarantineRecord(CamelModel):
    topic: str
    partition: int
    offset: int
    raw_payload: str
    reason: str
    schema_fingerprint: str | None = None
    rule_fingerprint: str | None = None
    rule_id: str | None = None
    stage: str | None = None
    target_column: str | None = None
    quarantined_at: str | None = None
    replay_status: str = "pending"


class ContinuousQuarantineResponse(CamelModel):
    job_id: str
    records: list[ContinuousQuarantineRecord] = Field(default_factory=list)
    total: int = 0


class ContinuousReplayRequest(CamelModel):
    offsets: list[str] = Field(default_factory=list)
    approve_unknown_fields: bool = False

    @field_validator("offsets")
    @classmethod
    def validate_offsets(cls, values: list[str]) -> list[str]:
        if len(values) > 1000:
            raise ValueError("offsets supports at most 1000 partition:offset values")
        normalized = []
        for value in values:
            parts = str(value).split(":", 1)
            if len(parts) != 2 or not all(part.isdigit() for part in parts):
                raise ValueError("each offset must use non-negative partition:offset format")
            normalized.append(f"{int(parts[0])}:{int(parts[1])}")
        return list(dict.fromkeys(normalized))


class ContinuousCompactionRequest(CamelModel):
    target_file_size_mb: int = Field(default=256, ge=128, le=512)


class ContinuousIcebergMaintenanceRequest(CamelModel):
    rewrite_data_files: bool = True
    target_file_size_mb: int = Field(default=256, ge=128, le=512)
    expire_snapshots: bool = False
    snapshot_retention_hours: int = Field(default=168, ge=24, le=8760)
    retain_last_snapshots: int = Field(default=10, ge=1, le=1000)
    remove_orphan_files: bool = False
    orphan_retention_hours: int = Field(default=168, ge=72, le=8760)

    @model_validator(mode="after")
    def require_operation(self):
        if not (self.rewrite_data_files or self.expire_snapshots or self.remove_orphan_files):
            raise ValueError("at least one Iceberg maintenance operation must be enabled")
        return self


class ContinuousMaintenanceRun(CamelModel):
    run_id: str
    job_id: str
    kind: Literal["quarantine_replay", "compaction", "iceberg_maintenance"]
    status: Literal["queued", "running", "success", "failed"]
    requested_by: str
    config: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None
    started_at: str | None = None
    ended_at: str | None = None
    last_error: str | None = None


class JobRunSummary(CamelModel):
    airflow_dag_id: str | None = None
    airflow_dag_run_id: str | None = None
    airflow_run_url: str | None = None
    airflow_state: str | None = None
    duration: str
    ended_at: str
    error_summary: str
    failed_stage: str
    input_bytes: int | None = None
    input_file_count: int | None = None
    input_rows: str
    output_file_count: int | None = None
    output_rows: str
    output_path: str | None = None
    run_id: str
    started_at: str
    status: JobRunStatus
    sync_error: str | None = None
    task_states: dict[str, Any] | None = None


class JobDagStep(CamelModel):
    completed_at: str | None = None
    details: SourceFieldRows | None = None
    duration: str | None = None
    id: str
    logs: list[str] | None = None
    meta: str
    note: str | None = None
    status: JobDagStepStatus
    title: str


class JobRowData(CamelModel):
    created_at: str | None = None
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
    updated_at: str | None = None
    schedule: str
    schedule_policy: dict[str, Any] | None = None
    schedule_summary: str | None = None
    source_config: SourceFieldRows | None = None
    source_label: str | None = None
    source_type: str | None = None
    job_kind: JobKind = "pipeline"
    sql_recipe: dict[str, Any] | None = None
    execution_mode: KafkaExecutionMode = "snapshot"
    continuous_config: dict[str, Any] | None = None
    continuous_runtime: KafkaContinuousRuntime | None = None
    record_parsing: RecordParsingDraft | dict[str, Any] | None = None
    schema_columns: list[SchemaColumnDraft] | list[dict[str, Any]] | None = None
    schema_fingerprint: str | None = None
    schema_sample_rows: list[list[str]] | None = None
    schema_summary: str | None = None
    rule_summary: str | None = None
    rule_contract_version: RuleContractVersion = "1.0"
    rules: list[CanonicalRuleDraft] = Field(default_factory=list)
    rule_compilation: RuleCompilationResult | None = None
    retry_policy: RetryPolicyDraft | dict[str, Any] | None = None
    retry_policy_summary: str | None = None
    run_limit_summary: str | None = None
    permission_roles: list[dict[str, Any]] | None = None
    permission_summary: str | None = None
    storage_type: str | None = None
    partition: str | None = None
    partition_columns: list[str] | None = None
    index_columns: list[str] | None = None
    compression: str | None = None
    storage_path: str | None = None
    iceberg_target: IcebergWriterTarget | None = None
    target_description: str | None = None
    target_database: str | None = None
    target_tags: list[str] | None = None
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


class JobListFacets(CamelModel):
    latest_run_outcome_counts: dict[JobRunOutcome, int]
    owners: list[str]
    status_counts: dict[JobStatus, int]
    total: int


class JobListResponse(CamelModel):
    facets: JobListFacets
    jobs: list[JobRowData]


class PermissionOptionGroup(CamelModel):
    id: str
    name: str
    description: str | None = None
    actions: list[PermissionAction] = Field(default_factory=list)


class PermissionOptionUser(CamelModel):
    id: str
    name: str
    email: str
    initials: str
    role: str


class PermissionOptionsResponse(CamelModel):
    groups: list[PermissionOptionGroup] = Field(default_factory=list)
    users: list[PermissionOptionUser] = Field(default_factory=list)
class DeleteJobResponse(CamelModel):
    deleted_job_id: str


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


class TrinoSqlJobSchedule(CamelModel):
    mode: Literal["manual", "daily", "weekly"] = "manual"
    overlap_policy: Literal["skip_if_running"] = "skip_if_running"
    time: str = "09:00"
    timezone: str = "Asia/Seoul"
    weekday: Literal["월", "화", "수", "목", "금", "토", "일"] = "월"


class TrinoSqlJobGovernance(CamelModel):
    access_scope: Literal["organization", "private", "project"] = "organization"
    owner: str
    permission_summary: str


class TrinoSqlJobTarget(CamelModel):
    partition_column: str | None = None
    write_mode: Literal["full_refresh"] = "full_refresh"


class CreateTrinoSqlJobRequest(CamelModel):
    base_dataset_id: str
    dataset: DerivedDatasetSpec
    governance: TrinoSqlJobGovernance
    job_name: str | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    schedule: TrinoSqlJobSchedule = Field(default_factory=TrinoSqlJobSchedule)
    source_run_id: str
    target: TrinoSqlJobTarget = Field(default_factory=TrinoSqlJobTarget)


class CreatePipelineRequest(CamelModel):
    id: str
    job_name: str
    schema_columns: list[SchemaColumnDraft] = Field(default_factory=list)
    schema_fingerprint: str | None = None
    schema_sample_rows: list[list[str]] = Field(default_factory=list)
    source_config: SourceFieldRows = Field(default_factory=list)
    source_type: str
    source_label: str
    execution_mode: KafkaExecutionMode = "snapshot"
    continuous_config: KafkaContinuousConfigDraft | None = None
    record_parsing: RecordParsingDraft | None = None
    schema_summary: str = ""
    rule_summary: str = ""
    rule_contract_version: str | None = None
    rules: list[CanonicalRuleDraft] = Field(default_factory=list)
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
    target_database: str | None = None
    target_description: str | None = None
    target_tags: list[str] = Field(default_factory=list)
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
    rule_compilation: RuleCompilationResult
    schema_: list[ReviewSchemaRow] = Field(alias="schema")
    validation: list[ReviewValidationRow]


class UpdatePipelineRequest(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, use_enum_values=True, extra="forbid")

    job_name: str
    schema_columns: list[SchemaColumnDraft] = Field(default_factory=list)
    schema_fingerprint: str | None = None
    schema_sample_rows: list[list[str]] = Field(default_factory=list)
    schema_summary: str = ""
    rule_summary: str = ""
    rule_contract_version: str | None = None
    rules: list[CanonicalRuleDraft] = Field(default_factory=list)
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
    permission_grants: list[PermissionGrant] | None = None
    storage_type: str | None = None
    partition: str | None = None
    partition_columns: list[str] | None = None
    index_columns: list[str] | None = None
    compression: str | None = None
    storage_path: str | None = None
    target_dataset: str
    target_database: str | None = None
    target_description: str | None = None
    target_tags: list[str] = Field(default_factory=list)
    target_layer: TargetLayer
    target_format: str
    owner: str
    rag: bool = False


class JobCommandRequest(CamelModel):
    command: JobCommand


class AirflowSparkExecutionRequest(CamelModel):
    command: Literal["run", "retry"] = "run"
    job_id: str


class AirflowCatalogReconciliationRequest(CamelModel):
    job_id: str


class AirflowCatalogReconciliationResponse(CamelModel):
    dataset: CatalogDataset
    reconciled_at: str
    run_id: str
    status: Literal["success"] = "success"


class JobCommandResponse(CamelModel):
    action: str
    api_path: str
    dataset: CatalogDataset | None = None
    job: JobRowData | None = None
    run: JobRunSummary | None = None
    dag_steps: list[JobDagStep] | None = None
    processing_result: dict[str, Any] | None = None


class AirflowRunExecutionRequest(CamelModel):
    command: Literal["run", "retry"] = "run"


class AirflowRunExecutionResponse(CamelModel):
    status: Literal["success", "failed"]
    job_id: str
    run_id: str
    dataset_id: str | None = None
    input_bytes: int = 0
    input_file_count: int = 0
    input_rows: int = 0
    output_file_count: int = 0
    output_rows: int = 0
    output_path: str = "-"
    duration_ms: int | None = None
    schema_: list[dict[str, Any]] = Field(default_factory=list, alias="schema")
    quality: dict[str, Any] | None = None
    failed_stage: str | None = None
    error: str | None = None


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
    broker: str = Field(default_factory=lambda: os.environ.get("ASKLAKE_KAFKA_BROKER") or "127.0.0.1:19092")
    topic: str = "reviews.raw"
    consumer_group_id: str | None = None
    dataset_id: str | None = None
    dataset_name: str = "reviews_raw"
    target_bucket: str = "asklake-output"
    target_description: str | None = None
    target_format: Literal["jsonl"] = "jsonl"
    target_layer: Literal["RAW", "BRONZE", "SILVER"] = "BRONZE"
    target_prefix: str = ""
    schema_columns: list[SchemaColumnDraft] = Field(default_factory=list)
    output_schema: SourceFieldRows = Field(default_factory=list)
    rule_contract_version: str | None = None
    rules: list[CanonicalRuleDraft] = Field(default_factory=list)
    transform_steps: list[TransformStepDraft] = Field(default_factory=list)
    quality_rules: list[QualityRuleDraft] = Field(default_factory=list)
    landing_bucket: str = "m3-raw"
    landing_endpoint: str = "http://127.0.0.1:9000"
    landing_prefix: str = "kafka-landing"
    local_landing_dir: str | None = None
    max_messages: int = Field(default=100, ge=1, le=1_000_000)
    offset_policy: Literal["earliest", "latest"] = "earliest"
    register_catalog: bool = True
    run_id: str | None = None
    storage_mode: Literal["local", "s3"] = "s3"
    test_fail_after_target_write: bool = False
    timeout_ms: int = Field(default=10000, ge=1000, le=300000)


class KafkaPartitionSnapshot(CamelModel):
    end_offset: str
    high_watermark: str
    partition: int
    start_offset: str


class KafkaSnapshot(CamelModel):
    captured_at: str
    consumer_group_id: str
    offset_policy: Literal["earliest", "latest"]
    partitions: list[KafkaPartitionSnapshot]
    snapshot_id: str
    topic: str


class KafkaReviewIngestResponse(CamelModel):
    broker: str
    catalog_dataset: dict[str, Any] | None = None
    consumed_count: int
    dataset_id: str | None = None
    dataset_name: str | None = None
    failed_count: int
    metadata_location: str
    run_id: str
    snapshot: KafkaSnapshot
    status: Literal["success"]
    storage_format: str
    storage_location: str
    storage_mode: Literal["local", "s3"]
    stored_count: int
    target_layer: Literal["RAW", "BRONZE", "SILVER"]
    topic: str
    transform: dict[str, Any] | None = None
    quality: dict[str, Any] | None = None


class KafkaReplayProducerRequest(CamelModel):
    topic: str = "reviews.raw"
    input_path: str | None = None
    payload_mode: Literal["json_envelope", "raw_text"] = "json_envelope"
    rate: int = Field(default=10, ge=1, le=100_000)
    batch_size: int = Field(default=100, ge=1, le=10_000)
    progress_every: int = Field(default=100, ge=1, le=100_000)
    loop: bool = True
    max_cycles: int | None = Field(default=None, ge=1, le=1_000_000)
    max_messages: int | None = Field(default=None, ge=1, le=100_000_000)
    cycle_delay_ms: int = Field(default=0, ge=0, le=3_600_000)
    burst_min_messages: int | None = Field(default=None, ge=1, le=1_000_000)
    burst_max_messages: int | None = Field(default=None, ge=1, le=1_000_000)
    burst_interval_seconds: int | None = Field(default=None, ge=1, le=3_600)

    @field_validator("input_path")
    @classmethod
    def validate_input_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or normalized.startswith("/") or ".." in normalized.split("/"):
            raise ValueError("inputPath must be a relative path inside the replay input directory")
        return normalized

    @model_validator(mode="after")
    def validate_loop_bounds(self) -> "KafkaReplayProducerRequest":
        if self.max_cycles is not None and not self.loop:
            raise ValueError("maxCycles requires loop=true")
        burst_values = [self.burst_min_messages, self.burst_max_messages, self.burst_interval_seconds]
        if any(value is not None for value in burst_values):
            if not self.loop or any(value is None for value in burst_values):
                raise ValueError("burst mode requires loop=true, burstMinMessages, burstMaxMessages, and burstIntervalSeconds")
            if self.burst_min_messages > self.burst_max_messages:
                raise ValueError("burstMinMessages must be less than or equal to burstMaxMessages")
        return self


class KafkaReplayProducerStatus(CamelModel):
    running: bool
    pid: int | None = None
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    sent_messages: int = 0
    completed_cycles: int = 0
    config: dict[str, Any] | None = None
    logs: list[str] = Field(default_factory=list)


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


class SourceConnectorDefaults(CamelModel):
    kafka_broker: str
    kafka_topic: str
    s3_bucket: str
    s3_prefix: str


class SourceAssetsRequest(CamelModel):
    prefix: str = ""
    source_config: SourceFieldRows = Field(default_factory=list)
    source_type: str


class SourceAssetsResponse(CamelModel):
    assets: list[tuple[str, str, str]]
    count: int | None = None
    limit: int | None = None
    prefix: str


class SourceDatasetSummary(CamelModel):
    selection_kind: Literal["prefix"]
    bucket: str
    prefix: str
    format: str
    file_count: int = Field(ge=1)
    total_bytes: int = Field(ge=0)
    representative_object: str
    schema_fingerprint: str | None = None
    schema_compatible: bool
    excluded_file_count: int = Field(ge=0)


class SourceConnectorAnalysis(CamelModel):
    action_path: str
    assets: list[tuple[str, str, str]]
    dataset_summary: SourceDatasetSummary | None = None
    draft_patch: DraftPipelinePatch
    logs: list[str]
    message: str
    preview_columns: list[str]
    preview_note: str
    preview_rows: list[list[str]]
    status: Literal["idle", "testing", "success", "failed"]
    test_items: list[tuple[str, str]]
