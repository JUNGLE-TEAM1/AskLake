from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel

QueryRunMode = Literal["preview", "run"]
QueryAiMode = Literal["draft_sql"]


class QueryRunRequest(CamelModel):
    base_dataset_id: str | None = None
    dataset_id: str
    limit: int | None = Field(default=None, ge=1, le=500)
    mode: QueryRunMode = "preview"
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    validation_key: str | None = None


class QueryRunResponse(CamelModel):
    base_dataset_id: str | None = None
    columns: list[str]
    dataset_id: str
    dataset_name: str
    executed_at: str
    mode: QueryRunMode | None = None
    preview_limit: int | None = None
    query: str
    reference_dataset_ids: list[str] = Field(default_factory=list)
    row_count: int
    rows: list[list[str]]
    run_id: str
    validation_key: str | None = None


SqlResultDraft = QueryRunResponse


class QueryAiSuggestionRequest(CamelModel):
    base_dataset_id: str | None = None
    current_query: str | None = None
    mode: QueryAiMode = "draft_sql"
    prompt: str = Field(min_length=1)
    selected_dataset_ids: list[str] = Field(default_factory=list)


class QueryAiSuggestionResponse(CamelModel):
    body: str
    mode: QueryAiMode = "draft_sql"
    model: str | None = None
    notices: list[str] = Field(default_factory=list)
    sql: str
    title: str
