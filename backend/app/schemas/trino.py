from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel

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
    columns: list[str] = Field(default_factory=list)
    next_cursor: str | None = None
    retention_expires_at: str | None = None
    row_count: int | None = None


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
    trino_query_id: str | None = None


class SubmitTrinoQueryRunRequest(CamelModel):
    base_dataset_id: str
    client_request_id: str | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    result_page_size: int | None = Field(default=None, ge=1, le=1000)


class QueryRunSubmitRequest(CamelModel):
    base_dataset_id: str | None = None
    client_request_id: str | None = None
    dataset_id: str | None = None
    limit: int | None = Field(default=None, ge=1, le=500)
    mode: Literal["preview", "run"] | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    result_page_size: int | None = Field(default=None, ge=1, le=1000)
    validation_key: str | None = None

    def trino_request(self) -> SubmitTrinoQueryRunRequest:
        base_dataset_id = self.base_dataset_id or self.dataset_id
        if not base_dataset_id:
            raise ValueError("baseDatasetId or datasetId is required")
        return SubmitTrinoQueryRunRequest(
            baseDatasetId=base_dataset_id,
            clientRequestId=self.client_request_id,
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


class TrinoClientPage(CamelModel):
    columns: list[str] = Field(default_factory=list)
    error: TrinoQueryRunError | None = None
    next_uri: str | None = None
    query_id: str
    raw_stats: dict[str, Any] = Field(default_factory=dict)
    rows: list[list[object]] = Field(default_factory=list)
    state: str | None = None
