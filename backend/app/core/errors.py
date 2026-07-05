from fastapi import Request, status
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = status.HTTP_400_BAD_REQUEST) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code


def error_response(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
            },
        },
    )


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return error_response(exc.code, exc.message, exc.status_code)


async def unhandled_error_handler(_: Request, __: Exception) -> JSONResponse:
    return error_response(
        "INTERNAL_SERVER_ERROR",
        "Internal server error",
        status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
