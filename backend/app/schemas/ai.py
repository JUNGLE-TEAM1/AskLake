from typing import Annotated, Any, Literal

from pydantic import ConfigDict, Field

from app.schemas.common import CamelModel


PermissionName = Literal["view", "query", "run", "manage", "delete", "share", "publish"]
AiContextShortText = Annotated[str, Field(max_length=255)]
AiContextSampleValue = Annotated[str, Field(max_length=256)]


class AiContextActor(CamelModel):
    name: str = Field(min_length=1, max_length=255)
    role: str = Field(min_length=1, max_length=100)
    groups: list[str] = Field(default_factory=list, max_length=100)
    id: str | None = Field(default=None, max_length=255)
    email: str | None = Field(default=None, max_length=320)


class AiContextClaims(CamelModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    audience: Literal["asklake-ai"] = "asklake-ai"
    request_id: str = Field(min_length=1, max_length=255)
    actor: AiContextActor
    allowed_dataset_ids: list[str] = Field(min_length=1, max_length=100)
    dataset_permissions: dict[str, list[PermissionName]] = Field(
        min_length=1,
        max_length=100,
    )
    issued_at: int = Field(ge=0)
    expires_at: int = Field(ge=0)


class AiContextColumn(CamelModel):
    name: str = Field(max_length=255)
    type: str = Field(max_length=128)


class CatalogDatasetContext(CamelModel):
    """Safe, allowlisted catalog context returned to the internal AI server."""

    dataset_id: str = Field(max_length=255)
    dataset_name: str = Field(max_length=255)
    description: str = Field(max_length=2_000)
    layer: str = Field(max_length=64)
    freshness: str = Field(max_length=64)
    last_updated: str = Field(max_length=128)
    quality: str = Field(max_length=128)
    row_count: str = Field(max_length=64)
    schema_: list[AiContextColumn] = Field(alias="schema", max_length=256)
    schema_truncated: bool = False
    tags: list[AiContextShortText] = Field(default_factory=list, max_length=64)
    upstream: list[AiContextShortText] = Field(default_factory=list, max_length=64)
    downstream: list[AiContextShortText] = Field(default_factory=list, max_length=64)
    sample_column_names: list[AiContextShortText] = Field(default_factory=list, max_length=64)
    sample_rows: list[list[AiContextSampleValue]] = Field(default_factory=list, max_length=20)
    sample_rows_truncated: bool = False


class AiGatewayQueryRequest(CamelModel):
    request_id: str = Field(min_length=1, max_length=255)
    prompt: str = Field(min_length=1, max_length=20_000)
    current_query: str = Field(default="", max_length=100_000)
    base_dataset_id: str | None = Field(default=None, max_length=255)
    rag_context: dict[str, Any] = Field(default_factory=dict)
    selected_dataset_ids: list[str] = Field(min_length=1, max_length=100)


class AiGatewayQueryResponse(CamelModel):
    """The stable contract returned by the internal AI server."""

    title: str
    body: str
    sql: str
    notices: list[str] = Field(default_factory=list)
    model: str


class AiGatewayProviderOutput(CamelModel):
    query_sql: str
    explanation: str
    warnings: list[str] = Field(default_factory=list)


class AiGatewayProviderResponse(CamelModel):
    request_id: str
    mode: str
    output: AiGatewayProviderOutput
    provider: str
    model: str
