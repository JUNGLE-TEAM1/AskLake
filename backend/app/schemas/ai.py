from datetime import datetime
from typing import Literal, Self

from pydantic import Field, model_validator

from app.schemas.common import CamelModel


class AiConversationMessage(CamelModel):
    id: str
    role: Literal["assistant", "user"]
    content: str
    context_names: list[str] = Field(default_factory=list)
    notices: list[str] = Field(default_factory=list)
    sql: str | None = None
    created_at: datetime


class AiConversationResponse(CamelModel):
    id: str
    title: str
    selected_dataset_ids: list[str] = Field(default_factory=list)
    messages: list[AiConversationMessage] = Field(default_factory=list)
    version: int = Field(ge=1)
    created_at: datetime
    updated_at: datetime


class AiConversationListResponse(CamelModel):
    items: list[AiConversationResponse] = Field(default_factory=list)


class CreateAiConversationRequest(CamelModel):
    title: str = Field(default="새 대화", min_length=1, max_length=120)
    selected_dataset_ids: list[str] = Field(default_factory=list, max_length=50)


class UpdateAiConversationRequest(CamelModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=120)
    selected_dataset_ids: list[str] | None = Field(default=None, max_length=50)

    @model_validator(mode="after")
    def require_change(self) -> Self:
        if self.title is None and self.selected_dataset_ids is None:
            raise ValueError("title or selectedDatasetIds is required")
        return self


class CreateAiConversationMessageRequest(CamelModel):
    version: int = Field(ge=1)
    client_request_id: str = Field(min_length=1, max_length=255)
    content: str = Field(min_length=1, max_length=8_000)
