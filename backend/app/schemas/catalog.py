from typing import Any, Literal

from pydantic import Field, model_validator

from app.schemas.common import CamelModel, CursorPageMeta
from app.schemas.permissions import PermissionGrant, ResourcePermissions

CatalogLayer = Literal["RAW", "BRONZE", "SILVER", "GOLD"]
DatasetFreshness = Literal["latest", "stale", "approval"]
DatasetStatus = Literal["available", "approval_required"]
DerivedDatasetLayer = Literal["SILVER", "GOLD"]
LineageLayer = Literal["SOURCE", "PROCESS", "RAW", "BRONZE", "SILVER", "GOLD", "CONSUMER"]
QueryRefreshPolicy = Literal["manual"]
MaterializationRunStatus = Literal["queued", "running", "success", "failed", "canceled"]
MaterializationSourceKind = Literal["etl", "sql", "kafka"]
MaterializationMode = Literal["snapshot", "delta"]
QueryEngineTableFormat = Literal["iceberg", "parquet"]
QueryEngineStatus = Literal["pending", "available", "registration_failed", "unavailable"]


class LineageGraphColumn(CamelModel):
    id: str
    name: str
    type: str


class LineageGraphDataset(CamelModel):
    columns: list[LineageGraphColumn]
    engine: str
    id: str
    layer: LineageLayer
    name: str


class LineageGraphEdge(CamelModel):
    from_column_id: str
    from_dataset_id: str
    to_column_id: str
    to_dataset_id: str


class LineageGraphResponse(CamelModel):
    dataset_id: str
    datasets: list[LineageGraphDataset]
    edges: list[LineageGraphEdge]


class QueryEngineTableRef(CamelModel):
    catalog: str
    schema_: str = Field(alias="schema")
    table: str
    format: QueryEngineTableFormat
    partition_columns: list[str] = Field(default_factory=list)


class DatasetMaterializationRun(CamelModel):
    created_at: str
    iceberg_committed_at: str | None = None
    iceberg_snapshot_id: str | None = None
    job_id: str
    kafka_snapshot: dict[str, Any] | None = None
    materialization_mode: MaterializationMode = "snapshot"
    publication_manifest: str | None = None
    quality: dict[str, Any] | None = None
    query_engine_table: QueryEngineTableRef | None = None
    row_count: int = 0
    rule_contract_version: str | None = None
    rule_fingerprint: str | None = None
    run_id: str
    runtime_fingerprint: str | None = None
    schema_fingerprint: str | None = None
    source_boundary: dict[str, Any] | None = None
    source_kind: MaterializationSourceKind = "etl"
    source_label: str
    source_ranges: list[dict[str, Any]] = Field(default_factory=list)
    status: MaterializationRunStatus
    storage_format: str | None = None
    storage_location: str | None = None
    storage_size_bytes: int = 0
    transform: dict[str, Any] | None = None


class CatalogDatasetResponse(CamelModel):
    created_by: str | None = None
    created_by_profile: dict[str, Any] | None = None
    permission_grants: list[PermissionGrant] = Field(default_factory=list)
    permissions: ResourcePermissions = Field(default_factory=ResourcePermissions)
    description: str
    downstream: list[str] = Field(default_factory=list)
    freshness: DatasetFreshness
    id: str
    layer: CatalogLayer
    last_updated: str
    lineage_graph: LineageGraphResponse | None = None
    materialization_runs: list[DatasetMaterializationRun] = Field(default_factory=list)
    name: str
    next_refresh: str
    owner: str
    quality: str
    rag: bool
    rows: str
    sample_rows: list[list[str]]
    schema_: list[tuple[str, str]] = Field(alias="schema")
    size: str
    source: str
    source_run_id: str | None = None
    status: DatasetStatus
    storage_format: str | None = None
    storage_location: str | None = None
    storage_size_bytes: int | None = None
    partition: str | None = None
    partition_columns: list[str] | None = None
    query_engine_table: QueryEngineTableRef | None = None
    query_engine_status: QueryEngineStatus = "unavailable"
    query_engine_error: str | None = None
    query_engine_required: bool = False
    index_columns: list[str] | None = None
    tags: list[str]
    upstream: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def infer_query_engine_status(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        if payload.get("queryEngineStatus") is None and payload.get("query_engine_status") is None:
            payload["queryEngineStatus"] = "available" if payload.get("queryEngineTable") or payload.get("query_engine_table") else "unavailable"
        query_engine_status = payload.get("queryEngineStatus") or payload.get("query_engine_status")
        if query_engine_status != "available":
            payload.pop("queryEngineTable", None)
            payload.pop("query_engine_table", None)
        if query_engine_status != "registration_failed":
            payload.pop("queryEngineError", None)
            payload.pop("query_engine_error", None)
        return payload


class CatalogDatasetListResponse(CamelModel):
    datasets: list[CatalogDatasetResponse]
    page: CursorPageMeta = Field(default_factory=CursorPageMeta)


class CatalogDatasetRowsResponse(CamelModel):
    columns: list[str]
    dataset_id: str
    dataset_name: str
    has_next: bool
    limit: int
    offset: int
    returned_rows: int
    row_count: int
    rows: list[list[str]]


class DeleteMaterializationRunResponse(CamelModel):
    dataset: CatalogDatasetResponse
    deleted_run_id: str


class CreateDerivedDatasetMetadata(CamelModel):
    description: str
    layer: DerivedDatasetLayer
    name: str
    rag: bool
    refresh_policy: QueryRefreshPolicy
    tags: list[str]


class CreateDerivedDatasetRequest(CamelModel):
    dataset: CreateDerivedDatasetMetadata
    preview_limit: int | None = Field(default=None, ge=1, le=500)
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    source_dataset_id: str
    source_run_id: str
    validation_key: str | None = None


CreateDerivedDatasetResponse = CatalogDatasetResponse
