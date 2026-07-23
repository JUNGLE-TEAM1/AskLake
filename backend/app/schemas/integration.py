from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel


class TargetDatabaseOption(CamelModel):
    description: str
    name: str


class TargetDatabasesResponse(CamelModel):
    databases: list[TargetDatabaseOption]


class S3PrefixFolder(CamelModel):
    name: str
    prefix: str
    type: Literal["folder"] = "folder"


class S3PrefixFile(CamelModel):
    key: str
    name: str
    type: Literal["file"] = "file"


class S3BucketsResponse(CamelModel):
    buckets: list[str]


class S3PrefixesResponse(CamelModel):
    bucket: str
    files: list[S3PrefixFile]
    folders: list[S3PrefixFolder]
    next_continuation_token: str | None = None
    prefix: str


class CatalogModelArtifactResponse(CamelModel):
    artifact_type: Literal["model"] = "model"
    id: str
    allowed_values: list[str] = []
    model_artifact: str | None = None
    model_kind: str | None = None
    method: str | None = None
    metrics: dict[str, Any] = {}
    provenance: dict[str, Any] = Field(default_factory=dict)
    output_column: str | None = None
    runtime_status: str | None = None
    status: str | None = None
    target_column: str | None = None
    updated_at: str | None = None
    validation_rows: int | None = None
    validation_status: str | None = None


class ReviewAnalysisSchemaSuggestionRequest(CamelModel):
    sample_rows: list[list[Any]] = []
    source_columns: list[dict[str, Any]] = []


class ReviewAnalysisSource(CamelModel):
    bucket: str = Field(min_length=1, max_length=255, pattern=r"^[^\r\n\x00]+$")
    key: str = Field(min_length=1, max_length=2_048, pattern=r"^[^\r\n\x00]+$")


class ReviewAnalysisRunRequest(CamelModel):
    limit: int = Field(default=25, ge=0, le=1_000_000)
    schema_columns: list[dict[str, Any]] | None = None
    full: bool = False
    runtime: Literal["gateway"] | None = None
    source: ReviewAnalysisSource | None = None
    train_models: bool = False


class ReviewAnalysisRunResponse(CamelModel):
    run_id: str
    status: Literal["queued", "running", "success", "failed"]
    source: ReviewAnalysisSource
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


class ReviewAnalysisStatusResponse(CamelModel):
    run_id: str | None = None
    status: Literal["idle", "queued", "running", "success", "failed"]
    source: dict[str, Any]
    result: dict[str, Any] | None = None
    error: str | None = None
    message: str | None = None
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


class ReviewAnalysisPreviewColumn(CamelModel):
    target_name: str = Field(min_length=1, max_length=255)
    source_field: str = Field(min_length=1, max_length=255)
    method: Literal["copy", "one_of_values", "instruction"]
    allowed_values: list[str] = Field(default_factory=list, max_length=64)
    instruction: str = Field(default="", max_length=2_000)


class ReviewAnalysisPreviewRequest(CamelModel):
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=10)
    columns: list[ReviewAnalysisPreviewColumn] = Field(min_length=1, max_length=64)


class ReviewAnalysisPreviewResponse(CamelModel):
    rows: list[dict[str, str]]
    model: str
    provider: str
    models: list[str] = Field(default_factory=list)
    providers: list[str] = Field(default_factory=list)
    runtime: Literal["gateway"] = "gateway"
    status: Literal["success"] = "success"
