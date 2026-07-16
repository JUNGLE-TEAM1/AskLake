from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel


AiGenerationPromptType = Literal[
    "query_page",
    "field_transform",
    "sql_transform",
    "partition",
    "general",
]


class AiSqlGenerationRequest(CamelModel):
    question: str = Field(min_length=1, max_length=8_000)
    prompt_type: AiGenerationPromptType = "general"
    metadata: dict[str, Any] = Field(default_factory=dict)
    context: str | None = Field(default=None, max_length=20_000)
    engine: str = Field(default="trino", min_length=1, max_length=64)


class AiSqlGenerationResponse(CamelModel):
    sql: str = Field(min_length=1)
    schema_context: str = ""
    model: str | None = None
