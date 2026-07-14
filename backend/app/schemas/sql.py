from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel

QueryRunMode = Literal["preview", "run"]
QueryAiMode = Literal["draft_sql"]

DEFAULT_QUERY_PAGE_LIMIT = 100
MAX_QUERY_PAGE_LIMIT = 500


class QueryRunRequest(CamelModel):
    base_dataset_id: str | None = None
    dataset_id: str
    limit: int | None = Field(default=None, ge=1, le=MAX_QUERY_PAGE_LIMIT)
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
    has_next: bool = False
    mode: QueryRunMode | None = None
    page_limit: int = DEFAULT_QUERY_PAGE_LIMIT
    page_offset: int = 0
    preview_limit: int | None = None
    query: str
    range_end: int = 0
    range_start: int = 0
    reference_dataset_ids: list[str] = Field(default_factory=list)
    returned_rows: int = 0
    row_count: int
    rows: list[list[str]]
    run_id: str
    validation_key: str | None = None


SqlResultDraft = QueryRunResponse


class QueryAiSuggestionRequest(CamelModel):
    base_dataset_id: str | None = Field(default=None, max_length=255)
    current_query: str | None = Field(default=None, max_length=20_000)
    mode: QueryAiMode = "draft_sql"
    prompt: str = Field(min_length=1, max_length=8_000)
    selected_dataset_ids: list[str] = Field(default_factory=list, max_length=100)


class QueryAiSuggestionResponse(CamelModel):
    body: str
    mode: QueryAiMode = "draft_sql"
    model: str | None = None
    notices: list[str] = Field(default_factory=list)
    sql: str
    title: str
