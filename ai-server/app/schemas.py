import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


GenerationMode = Literal["query_sql"]


class QuerySqlOutput(BaseModel):
    """The only provider output accepted by the gateway contract."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query_sql: str = Field(min_length=1, max_length=20_000)
    explanation: str = Field(max_length=4_000)
    warnings: list[str] = Field(max_length=8)

    @field_validator("warnings")
    @classmethod
    def validate_warnings(cls, value: list[str]) -> list[str]:
        if any(len(warning) > 500 for warning in value):
            raise ValueError("Each warning must be at most 500 characters")
        return value


class GenerateRequest(BaseModel):
    """Stable internal request shape with bounded context/tool extension points.

    With MCP enabled, the gateway resolves only the fixed AskLake Catalog
    context tool. It never executes provider-supplied tools or interprets
    generic context values as instructions.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    mode: GenerationMode = "query_sql"
    request_id: str | None = Field(default=None, max_length=255)
    prompt: str = Field(min_length=1, max_length=8_000)
    current_query: str | None = Field(default=None, max_length=20_000)
    base_dataset_id: str | None = Field(default=None, max_length=255)
    selected_dataset_ids: list[str] = Field(default_factory=list, max_length=100)
    context: dict[str, Any] = Field(default_factory=dict)
    tools: list[dict[str, Any]] = Field(default_factory=list, max_length=16)


class GenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    mode: GenerationMode = "query_sql"
    output: QuerySqlOutput
    provider: str
    model: str


def compact_json_size(value: Any) -> int:
    """Return the UTF-8 size used for bounded generic payload validation."""

    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )
