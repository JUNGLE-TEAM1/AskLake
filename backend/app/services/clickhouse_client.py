from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
import json
import re
from typing import Any, Iterable

import httpx

from app.core.config import Settings, settings


_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class ClickHouseError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ClickHouseRows:
    columns: list[str]
    rows: list[list[Any]]


class ClickHouseClient:
    """Bounded ClickHouse HTTP client used by the control plane and dashboard."""

    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = runtime_settings or settings
        auth = None
        if self.settings.clickhouse_user:
            auth = (
                self.settings.clickhouse_user,
                self.settings.clickhouse_password or "",
            )
        self._client = httpx.Client(
            base_url=self.settings.clickhouse_url.rstrip("/"),
            auth=auth,
            timeout=self.settings.clickhouse_query_timeout_seconds,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def ping(self) -> bool:
        result = self.query("SELECT 1 AS ok")
        return bool(result.rows and int(result.rows[0][0]) == 1)

    def execute(
        self,
        query: str,
        *,
        database: str | None = None,
        query_id: str | None = None,
    ) -> str:
        response = self._post(query, database=database, query_id=query_id)
        return response.text

    def query(
        self,
        query: str,
        *,
        database: str | None = None,
        timeout_seconds: float | None = None,
    ) -> ClickHouseRows:
        normalized = query.strip().rstrip(";")
        response = self._post(
            f"{normalized}\nFORMAT JSON",
            database=database,
            timeout_seconds=timeout_seconds,
        )
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise ClickHouseError(
                "CLICKHOUSE_RESPONSE_INVALID",
                "ClickHouse returned an invalid JSON response.",
            ) from exc
        meta = payload.get("meta") if isinstance(payload, dict) else None
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(meta, list) or not isinstance(data, list):
            raise ClickHouseError(
                "CLICKHOUSE_RESPONSE_INVALID",
                "ClickHouse query response is missing meta or data.",
            )
        columns = [str(item.get("name") or "") for item in meta if isinstance(item, dict)]
        rows = [
            [item.get(column) for column in columns]
            for item in data
            if isinstance(item, dict)
        ]
        return ClickHouseRows(columns=columns, rows=rows)

    def insert_json_rows(
        self,
        database: str,
        table: str,
        columns: Iterable[str],
        rows: Iterable[Iterable[Any]],
    ) -> int:
        column_names = [validate_clickhouse_identifier(item) for item in columns]
        payload_rows = []
        for row in rows:
            values = list(row)
            payload_rows.append({
                column: values[index] if index < len(values) else None
                for index, column in enumerate(column_names)
            })
        if not payload_rows:
            return 0
        target = qualified_clickhouse_table(database, table)
        projection = ", ".join(quote_clickhouse_identifier(item) for item in column_names)
        body = (
            f"INSERT INTO {target} ({projection}) FORMAT JSONEachRow\n"
            + "\n".join(
                json.dumps(item, ensure_ascii=False, default=clickhouse_json_default)
                for item in payload_rows
            )
        )
        self._post(body, database=database)
        return len(payload_rows)

    def _post(
        self,
        body: str,
        *,
        database: str | None,
        timeout_seconds: float | None = None,
        query_id: str | None = None,
    ) -> httpx.Response:
        params = {
            "database": validate_clickhouse_identifier(
                database or self.settings.clickhouse_database
            ),
            "wait_end_of_query": "1",
        }
        if query_id is not None:
            normalized_query_id = str(query_id).strip()
            if not normalized_query_id or len(normalized_query_id) > 255:
                raise ValueError("ClickHouse query_id must contain 1 to 255 characters")
            params["query_id"] = normalized_query_id
        try:
            response = self._client.post(
                "/",
                params=params,
                content=body.encode("utf-8"),
                headers={"Content-Type": "text/plain; charset=utf-8"},
                timeout=timeout_seconds or self.settings.clickhouse_query_timeout_seconds,
            )
            response.raise_for_status()
            return response
        except httpx.TimeoutException as exc:
            raise ClickHouseError(
                "CLICKHOUSE_TIMEOUT",
                "ClickHouse query exceeded the configured timeout.",
            ) from exc
        except httpx.HTTPStatusError as exc:
            reason = " ".join(exc.response.text.strip().split())[:500]
            raise ClickHouseError(
                "CLICKHOUSE_QUERY_FAILED",
                reason or f"ClickHouse returned HTTP {exc.response.status_code}.",
            ) from exc
        except httpx.HTTPError as exc:
            raise ClickHouseError(
                "CLICKHOUSE_UNAVAILABLE",
                "ClickHouse is unavailable.",
            ) from exc


def validate_clickhouse_identifier(value: Any) -> str:
    normalized = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(normalized):
        raise ValueError("Invalid ClickHouse identifier")
    return normalized


def quote_clickhouse_identifier(value: Any) -> str:
    return f"`{validate_clickhouse_identifier(value)}`"


def qualified_clickhouse_table(database: Any, table: Any) -> str:
    return ".".join((
        quote_clickhouse_identifier(database),
        quote_clickhouse_identifier(table),
    ))


def quote_clickhouse_string(value: Any) -> str:
    normalized = str(value or "")
    return "'" + normalized.replace("\\", "\\\\").replace("'", "\\'") + "'"


def clickhouse_json_default(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"Unsupported ClickHouse JSON value: {type(value).__name__}")
