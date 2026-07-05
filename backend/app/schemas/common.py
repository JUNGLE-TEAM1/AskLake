from enum import Enum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

DataT = TypeVar("DataT")

DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 100


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        use_enum_values=True,
    )


class ErrorCode(str, Enum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    INVALID_JOB_STATE = "INVALID_JOB_STATE"
    SQL_SYNTAX_ERROR = "SQL_SYNTAX_ERROR"
    BACKEND_TIMEOUT = "BACKEND_TIMEOUT"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    NO_DRAFT_REVISION = "NO_DRAFT_REVISION"


class SortDirection(str, Enum):
    ASC = "asc"
    DESC = "desc"


class ErrorDetail(CamelModel):
    code: ErrorCode | str
    message: str
    details: dict[str, Any] | None = None


class ErrorResponse(CamelModel):
    error: ErrorDetail


class PageRequest(CamelModel):
    page: int = Field(default=DEFAULT_PAGE, ge=1)
    page_size: int = Field(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE)


class PageMeta(CamelModel):
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=MAX_PAGE_SIZE)


class CursorPageMeta(CamelModel):
    cursor: str | None = None
    has_next: bool = False


class PageResponse(CamelModel, Generic[DataT]):
    items: list[DataT]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=MAX_PAGE_SIZE)


class HealthResponse(CamelModel):
    ok: bool
    status_code: int
    database: dict[str, Any]
