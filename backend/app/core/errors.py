import logging
from typing import Any

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.schemas.common import ErrorCode, ErrorDetail, ErrorResponse
from app.core.observability import (
    CORRELATION_ID_HEADER,
    current_correlation_id,
    ensure_correlation_id,
    increment_metric,
    log_event,
    redact,
)


logger = logging.getLogger("asklake.errors")


class ApiError(Exception):
    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        details: dict[str, Any] | None = None,
        *,
        stage: str = "api",
        retryable: bool | None = None,
        operator_message: str | None = None,
        user_message: str | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details
        self.stage = stage
        self.retryable = status_code >= 500 if retryable is None else retryable
        self.operator_message = operator_message or message
        self.user_message = user_message or message


def error_response(
    code: ErrorCode | str,
    message: str,
    status_code: int,
    details: dict[str, Any] | None = None,
    *,
    stage: str = "api",
    retryable: bool = False,
    operator_message: str | None = None,
    user_message: str | None = None,
    diagnostic_id: str | None = None,
) -> JSONResponse:
    diagnostic_id = diagnostic_id or current_correlation_id() or ensure_correlation_id()
    safe_user_message = user_message or message
    response = ErrorResponse(
        error=ErrorDetail(
            code=code,
            message=safe_user_message,
            details=redact(details),
            stage=stage,
            retryable=retryable,
            operator_message=operator_message,
            user_message=safe_user_message,
            diagnostic_id=diagnostic_id,
        )
    )

    return JSONResponse(
        status_code=status_code,
        content=response.model_dump(by_alias=True, exclude_none=True, mode="json"),
        headers={CORRELATION_ID_HEADER: diagnostic_id},
    )


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    diagnostic_id = _request_diagnostic_id(request)
    increment_metric("api_errors_total", code=str(exc.code), stage=exc.stage)
    log_event(logger, "api_error", level=logging.WARNING, correlationId=diagnostic_id, code=str(exc.code), stage=exc.stage, details=exc.details)
    return error_response(
        exc.code,
        exc.message,
        exc.status_code,
        exc.details,
        stage=exc.stage,
        retryable=exc.retryable,
        operator_message=exc.operator_message,
        user_message=exc.user_message,
        diagnostic_id=diagnostic_id,
    )


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    increment_metric("api_errors_total", code=ErrorCode.VALIDATION_ERROR.value, stage="validation")
    # RequestValidationError does not consistently expose Pydantic v2's
    # ``include_input`` keyword across our supported FastAPI versions. Strip
    # request input values ourselves so an expected 422 never becomes a 500
    # and validation details cannot echo credentials.
    validation_errors = [
        {key: value for key, value in error.items() if key != "input"}
        for error in exc.errors()
    ]
    return error_response(
        ErrorCode.VALIDATION_ERROR,
        "Request validation failed",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {"errors": validation_errors},
        stage="validation",
        user_message="입력값을 확인해 주세요.",
        diagnostic_id=_request_diagnostic_id(request),
    )


async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = ErrorCode.NOT_FOUND if exc.status_code == status.HTTP_404_NOT_FOUND else ErrorCode.INTERNAL_ERROR
    return error_response(
        code,
        str(exc.detail or "HTTP error"),
        exc.status_code,
        retryable=exc.status_code >= 500,
        diagnostic_id=_request_diagnostic_id(request),
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    diagnostic_id = _request_diagnostic_id(request)
    increment_metric("api_errors_total", code=ErrorCode.INTERNAL_ERROR.value, stage="unhandled")
    log_event(
        logger,
        "unhandled_api_error",
        level=logging.ERROR,
        correlationId=diagnostic_id,
        exceptionType=exc.__class__.__name__,
    )
    return error_response(
        ErrorCode.INTERNAL_ERROR,
        "Internal server error",
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        stage="unhandled",
        retryable=True,
        operator_message=f"Unhandled {exc.__class__.__name__}",
        user_message="요청 처리 중 오류가 발생했습니다. 진단 ID를 운영자에게 전달해 주세요.",
        diagnostic_id=diagnostic_id,
    )


def _request_diagnostic_id(request: Request) -> str:
    return str(getattr(request.state, "correlation_id", "") or current_correlation_id() or ensure_correlation_id())
