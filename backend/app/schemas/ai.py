from typing import Literal

from pydantic import ConfigDict, Field

from app.schemas.common import CamelModel


PermissionName = Literal["view", "query", "run", "manage", "delete", "share"]


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
    name: str
    type: str


class CatalogDatasetContext(CamelModel):
    """Safe, allowlisted catalog context returned to the internal AI server."""

    dataset_id: str
    dataset_name: str
    description: str
    layer: str
    freshness: str
    last_updated: str
    quality: str
    row_count: str
    schema_: list[AiContextColumn] = Field(alias="schema")
    tags: list[str] = Field(default_factory=list)
    upstream: list[str] = Field(default_factory=list)
    downstream: list[str] = Field(default_factory=list)
    sample_rows: list[list[str]] = Field(default_factory=list)


class AiGatewayQueryRequest(CamelModel):
    request_id: str = Field(min_length=1, max_length=255)
    prompt: str = Field(min_length=1, max_length=20_000)
    current_query: str = Field(default="", max_length=100_000)
    base_dataset_id: str | None = Field(default=None, max_length=255)
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
