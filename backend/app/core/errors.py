from typing import Any

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.schemas.common import ErrorCode, ErrorDetail, ErrorResponse


class ApiError(Exception):
    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


def error_response(
    code: ErrorCode | str,
    message: str,
    status_code: int,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    response = ErrorResponse(
        error=ErrorDetail(
            code=code,
            message=message,
            details=details,
        )
    )

    return JSONResponse(
        status_code=status_code,
        content=response.model_dump(by_alias=True, exclude_none=True, mode="json"),
    )


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return error_response(exc.code, exc.message, exc.status_code, exc.details)


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return error_response(
        ErrorCode.VALIDATION_ERROR,
        "Request validation failed",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {"errors": exc.errors()},
    )


async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = ErrorCode.NOT_FOUND if exc.status_code == status.HTTP_404_NOT_FOUND else ErrorCode.INTERNAL_ERROR
    return error_response(code, str(exc.detail or "HTTP error"), exc.status_code)


async def unhandled_error_handler(_: Request, __: Exception) -> JSONResponse:
    return error_response(
        ErrorCode.INTERNAL_ERROR,
        "Internal server error",
        status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
