from typing import Any

from pydantic import BaseModel, ConfigDict


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


class ErrorDetail(CamelModel):
    code: str
    message: str


class ErrorResponse(CamelModel):
    error: ErrorDetail


class HealthResponse(CamelModel):
    ok: bool
    status_code: int
    database: dict[str, Any]
