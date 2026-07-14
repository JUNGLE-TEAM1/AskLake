from typing import Any, Literal

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


class ReviewAnalysisRunRequest(CamelModel):
    limit: int = 50000
    schema_columns: list[dict[str, Any]] | None = None
    full: bool = False
    runtime: str | None = None
