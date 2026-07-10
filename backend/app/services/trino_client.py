import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import status

from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoClientPage, TrinoQueryRunError


class TrinoClient:
    """Small wrapper around Trino's direct HTTP client protocol."""

    def __init__(self, runtime_settings: Settings | None = None) -> None:
        self.settings = runtime_settings or settings

    def submit(self, query: str) -> TrinoClientPage:
        endpoint = f"{self.settings.trino_base_url.rstrip('/')}/v1/statement"
        return self._request(
            endpoint,
            method="POST",
            body=query.encode("utf-8"),
            headers={
                "Content-Type": "text/plain; charset=utf-8",
                "X-Trino-Catalog": self.settings.trino_catalog,
                "X-Trino-Schema": self.settings.trino_schema,
                "X-Trino-User": self.settings.trino_user,
            },
        )

    def fetch(self, next_uri: str) -> TrinoClientPage:
        return self._request(next_uri, method="GET")

    def cancel(self, next_uri: str) -> None:
        self._request(next_uri, method="DELETE", allow_empty_response=True)

    def _request(
        self,
        url: str,
        *,
        method: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        allow_empty_response: bool = False,
    ) -> TrinoClientPage:
        request = Request(
            url,
            data=body,
            headers={"Accept": "application/json", **(headers or {})},
            method=method,
        )
        try:
            with urlopen(request, timeout=self.settings.trino_query_timeout_seconds) as response:
                response_text = response.read().decode("utf-8")
        except HTTPError as exc:
            message = read_error_message(exc)
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT if exc.code in {429, 502, 503, 504} else ErrorCode.INTERNAL_ERROR,
                "Trino request failed",
                status.HTTP_503_SERVICE_UNAVAILABLE if exc.code in {429, 502, 503, 504} else status.HTTP_502_BAD_GATEWAY,
                {"status": exc.code, "message": message},
            ) from exc
        except URLError as exc:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "Trino coordinator is unavailable",
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"reason": str(exc.reason)},
            ) from exc

        if allow_empty_response and not response_text.strip():
            return TrinoClientPage(query_id="", raw_stats={})

        try:
            payload = json.loads(response_text)
        except json.JSONDecodeError as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "Trino returned an invalid response",
                status.HTTP_502_BAD_GATEWAY,
            ) from exc
        return parse_trino_page(payload)


def parse_trino_page(payload: dict[str, Any]) -> TrinoClientPage:
    error_payload = payload.get("error")
    error = None
    if isinstance(error_payload, dict):
        error = TrinoQueryRunError(
            code=str(error_payload.get("errorCode") or error_payload.get("errorName") or "TRINO_ERROR"),
            message=str(error_payload.get("message") or "Trino query failed"),
        )

    columns = [
        str(column.get("name") or "")
        for column in payload.get("columns", [])
        if isinstance(column, dict) and str(column.get("name") or "")
    ]
    raw_stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
    return TrinoClientPage(
        columns=columns,
        error=error,
        next_uri=string_or_none(payload.get("nextUri")),
        query_id=str(payload.get("id") or ""),
        raw_stats=raw_stats,
        state=string_or_none(raw_stats.get("state")),
    )


def read_error_message(error: HTTPError) -> str:
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return str(error.reason)
    if isinstance(payload, dict):
        return str(payload.get("message") or payload.get("error") or error.reason)
    return str(error.reason)


def string_or_none(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None
