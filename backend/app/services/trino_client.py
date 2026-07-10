import base64
import json
import ssl
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from fastapi import status

from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoClientPage, TrinoQueryRunError


class TrinoClient:
    """Small wrapper around Trino's direct HTTP client protocol."""

    def __init__(self, runtime_settings: Settings | None = None, *, username: str | None = None, password: str | None = None) -> None:
        self.settings = runtime_settings or settings
        self.username = username or self.settings.trino_auth_username or self.settings.trino_user
        self.password = password
        ssl_context = ssl.create_default_context(cafile=self.settings.trino_tls_ca_file) if self.settings.trino_tls_ca_file else None
        handlers: list[object] = [NoRedirectHandler()]
        if ssl_context is not None:
            handlers.append(HTTPSHandler(context=ssl_context))
        self.opener = build_opener(*handlers)

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
                **self._identity_headers(),
            },
        )

    def fetch(self, next_uri: str) -> TrinoClientPage:
        validate_next_uri(next_uri, self.settings.trino_base_url)
        return self._request(next_uri, method="GET", headers=self._identity_headers())

    def cancel(self, next_uri: str) -> None:
        validate_next_uri(next_uri, self.settings.trino_base_url)
        self._request(next_uri, method="DELETE", headers=self._identity_headers(), allow_empty_response=True)

    def explain(self, query: str) -> str:
        """Return a bounded distributed plan without running the user query."""
        page = self.submit(f"EXPLAIN (TYPE DISTRIBUTED) {query}")
        plan_lines = page_rows_as_text(page)
        for _ in range(20):
            if page.error is not None:
                raise ApiError(ErrorCode.CONFLICT, page.error.message, status.HTTP_422_UNPROCESSABLE_ENTITY)
            if not page.next_uri:
                return "\n".join(plan_lines)
            page = self.fetch(page.next_uri)
            plan_lines.extend(page_rows_as_text(page))
        raise ApiError(ErrorCode.BACKEND_TIMEOUT, "Trino explain exceeded the page limit", status.HTTP_503_SERVICE_UNAVAILABLE)

    def _identity_headers(self) -> dict[str, str]:
        return {"X-Trino-User": self.username, **self._auth_headers()}

    def _auth_headers(self) -> dict[str, str]:
        password = self.password if self.password is not None else self.settings.trino_auth_password
        if not password:
            return {}
        token = base64.b64encode(f"{self.username}:{password}".encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {token}"}

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
            with self.opener.open(request, timeout=self.settings.trino_query_timeout_seconds) as response:
                raw_response = response.read(self.settings.trino_max_response_bytes + 1)
        except HTTPError as exc:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT if exc.code in {429, 502, 503, 504} else ErrorCode.INTERNAL_ERROR,
                "Trino request failed",
                status.HTTP_503_SERVICE_UNAVAILABLE if exc.code in {429, 502, 503, 504} else status.HTTP_502_BAD_GATEWAY,
                {"status": exc.code},
            ) from exc
        except URLError as exc:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "Trino coordinator is unavailable",
                status.HTTP_503_SERVICE_UNAVAILABLE,
                None,
            ) from exc

        if len(raw_response) > self.settings.trino_max_response_bytes:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "Trino response exceeded the configured safety limit",
                status.HTTP_502_BAD_GATEWAY,
            )
        try:
            response_text = raw_response.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "Trino returned an invalid response",
                status.HTTP_502_BAD_GATEWAY,
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
        rows=[row for row in payload.get("data", []) if isinstance(row, list)],
        state=string_or_none(raw_stats.get("state")),
    )


def string_or_none(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def page_rows_as_text(page: TrinoClientPage) -> list[str]:
    return [str(row[0]) for row in page.rows if row and row[0] is not None]


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> Request | None:
        return None


def validate_next_uri(next_uri: str, base_url: str) -> None:
    next_parts = urlsplit(next_uri)
    base_parts = urlsplit(base_url)
    next_port = next_parts.port or (443 if next_parts.scheme == "https" else 80)
    base_port = base_parts.port or (443 if base_parts.scheme == "https" else 80)
    if (
        next_parts.scheme not in {"http", "https"}
        or next_parts.username
        or next_parts.password
        or next_parts.hostname != base_parts.hostname
        or next_port != base_port
        or next_parts.scheme != base_parts.scheme
        or not next_parts.path.startswith("/v1/statement")
    ):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid Trino query continuation URL",
            status.HTTP_502_BAD_GATEWAY,
        )
