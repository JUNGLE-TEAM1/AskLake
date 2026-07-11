from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import CamelModel
from app.schemas.catalog import QueryEngineStatus

TrinoQueryRunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class TrinoQueryRunError(CamelModel):
    code: str
    message: str


class TrinoQueryRunStats(CamelModel):
    cpu_ms: int | None = None
    elapsed_ms: int | None = None
    peak_memory_bytes: int | None = None
    processed_bytes: int | None = None
    processed_rows: int | None = None
    queued_ms: int | None = None


class TrinoQueryRunResult(CamelModel):
    available_page_count: int | None = None
    byte_size: int | None = None
    columns: list[str] = Field(default_factory=list)
    next_cursor: str | None = None
    page_count: int | None = None
    retention_expires_at: str | None = None
    row_count: int | None = None
    storage: Literal["postgres", "minio"] | None = None
    storage_status: Literal["collecting", "available", "expired", "unavailable"] | None = None


class TrinoQueryRunResultPage(CamelModel):
    columns: list[str] = Field(default_factory=list)
    next_cursor: str | None = None
    page_size: int
    rows: list[list[object]] = Field(default_factory=list)
    run_id: str


class TrinoMaterializationRunResponse(CamelModel):
    dataset_id: str
    dataset_name: str
    materialization_id: str
    source_run_id: str
    status: TrinoQueryRunStatus
    query_engine_status: QueryEngineStatus = "pending"
    trino_query_id: str | None = None


class SubmitTrinoQueryRunRequest(CamelModel):
    base_dataset_id: str
    client_request_id: str | None = Field(default=None, min_length=1, max_length=128)
    confirmation_token: str | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    result_page_size: int | None = Field(default=None, ge=1, le=1000)

    @field_validator("client_request_id")
    @classmethod
    def normalize_client_request_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("clientRequestId must not be blank")
        return normalized


class TrinoQueryEstimateRequest(CamelModel):
    base_dataset_id: str
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)


class TrinoQueryEstimate(CamelModel):
    confirmation_required: bool = False
    confirmation_token: str | None = None
    estimated_bytes: int | None = None
    estimated_duration_seconds: int | None = None
    estimate_source: Literal["trino_plan", "catalog_heuristic"] = "catalog_heuristic"
    known_input_bytes: int = 0
    risk_level: Literal["low", "medium", "high"]
    warnings: list[str] = Field(default_factory=list)


class QueryRunSubmitRequest(CamelModel):
    base_dataset_id: str | None = None
    client_request_id: str | None = Field(default=None, min_length=1, max_length=128)
    confirmation_token: str | None = None
    dataset_id: str | None = None
    limit: int | None = Field(default=None, ge=1, le=500)
    mode: Literal["preview", "run"] | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    result_page_size: int | None = Field(default=None, ge=1, le=1000)
    validation_key: str | None = None

    @field_validator("client_request_id")
    @classmethod
    def normalize_client_request_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("clientRequestId must not be blank")
        return normalized

    def trino_request(self) -> SubmitTrinoQueryRunRequest:
        base_dataset_id = self.base_dataset_id or self.dataset_id
        if not base_dataset_id:
            raise ValueError("baseDatasetId or datasetId is required")
        return SubmitTrinoQueryRunRequest(
            baseDatasetId=base_dataset_id,
            clientRequestId=self.client_request_id,
            confirmationToken=self.confirmation_token,
            query=self.query,
            referenceDatasetIds=self.reference_dataset_ids,
            resultPageSize=self.result_page_size,
        )


class TrinoQueryRunResponse(CamelModel):
    base_dataset_id: str
    completed_at: str | None = None
    engine: Literal["trino"] = "trino"
    error: TrinoQueryRunError | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    result: TrinoQueryRunResult | None = None
    run_id: str
    started_at: str | None = None
    stats: TrinoQueryRunStats | None = None
    status: TrinoQueryRunStatus
    submitted_by_name: str | None = None
    submitted_by_user_id: str | None = None
    submitted_at: str
    trino_query_id: str | None = None


class TrinoQueryRunHistoryResult(CamelModel):
    row_count: int | None = None
    storage_status: Literal["collecting", "available", "expired", "unavailable"] | None = None


class TrinoQueryRunHistoryStats(CamelModel):
    processed_bytes: int | None = None


class TrinoQueryRunHistoryItem(CamelModel):
    base_dataset_id: str
    completed_at: str | None = None
    query: str
    result: TrinoQueryRunHistoryResult | None = None
    run_id: str
    stats: TrinoQueryRunHistoryStats | None = None
    status: TrinoQueryRunStatus
    submitted_at: str


class TrinoQueryRunListResponse(CamelModel):
    items: list[TrinoQueryRunHistoryItem] = Field(default_factory=list)


class TrinoClientPage(CamelModel):
    columns: list[str] = Field(default_factory=list)
    error: TrinoQueryRunError | None = None
    next_uri: str | None = None
    query_id: str
    raw_stats: dict[str, Any] = Field(default_factory=dict)
    rows: list[list[object]] = Field(default_factory=list)
    state: str | None = None
