from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel, CursorPageMeta

CatalogLayer = Literal["RAW", "BRONZE", "SILVER", "GOLD"]
DatasetFreshness = Literal["latest", "stale", "approval"]
DatasetStatus = Literal["available", "approval_required"]
DerivedDatasetLayer = Literal["SILVER", "GOLD"]
LineageLayer = Literal["SOURCE", "RAW", "BRONZE", "SILVER", "GOLD", "CONSUMER"]
QueryRefreshPolicy = Literal["manual"]


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


class CatalogDatasetResponse(CamelModel):
    description: str
    downstream: list[str] = Field(default_factory=list)
    freshness: DatasetFreshness
    id: str
    layer: CatalogLayer
    last_updated: str
    lineage_graph: LineageGraphResponse | None = None
    name: str
    next_refresh: str
    owner: str
    quality: str
    rag: bool
    rows: str
    sample_rows: list[list[str]]
    schema: list[tuple[str, str]]
    size: str
    source: str
    status: DatasetStatus
    tags: list[str]
    upstream: list[str] = Field(default_factory=list)


class CatalogDatasetListResponse(CamelModel):
    datasets: list[CatalogDatasetResponse]
    page: CursorPageMeta = Field(default_factory=CursorPageMeta)


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
