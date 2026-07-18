from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import logging
import re
import time
from typing import Any

from app.core.config import Settings
from app.core.observability import log_event
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    quote_clickhouse_identifier,
    quote_clickhouse_string,
)
from app.services.iceberg_dataset_reader import execute_trino_rows, quote_trino_identifier
from app.services.trino_client import TrinoClient


logger = logging.getLogger(__name__)

STATIC_CACHE_REGISTRY_TABLE = "asklake_static_cache_registry"
STATIC_CACHE_REGISTRY_VERSION = "clickhouse-static-cache-v1"
STATIC_CACHE_TEMP_BYTES_PER_ROW = 32


@dataclass(frozen=True)
class StaticSnapshotCacheIdentity:
    cache_key: str
    dataset_id: str
    snapshot_id: str
    schema_fingerprint: str
    schema: tuple[tuple[str, str], ...]
    join_columns: tuple[str, ...]


@dataclass(frozen=True)
class RegisteredStaticSnapshot:
    table_name: str
    row_count: int


class ClickHouseStaticSnapshotCache:
    """Loads immutable Iceberg dimensions once and reuses verified ClickHouse tables."""

    def __init__(self, runtime_settings: Settings, trino_client: TrinoClient) -> None:
        self.settings = runtime_settings
        self.trino_client = trino_client

    def resolve(
        self,
        client: ClickHouseClient,
        *,
        database: str,
        preferred_table: str,
        relation: dict[str, Any],
        binding: dict[str, Any],
        join_columns: list[str],
    ) -> str:
        identity = static_snapshot_cache_identity(relation, binding, join_columns)
        self._ensure_registry(client, database)
        registered = self._registered_snapshot(client, database, identity.cache_key)
        if registered is not None:
            state = self._table_state(
                client,
                database,
                registered.table_name,
                list(identity.schema),
                registered.row_count,
            )
            if state == "ready":
                log_event(
                    logger,
                    "clickhouse_static_cache_hit",
                    datasetId=identity.dataset_id,
                    snapshotId=identity.snapshot_id,
                    table=registered.table_name,
                    rowCount=registered.row_count,
                )
                return registered.table_name
            if state != "missing":
                raise ClickHouseError(
                    "CLICKHOUSE_STATIC_CACHE_CORRUPT",
                    "Verified ClickHouse static cache no longer matches its immutable identity.",
                )
            log_event(
                logger,
                "clickhouse_static_cache_stale",
                datasetId=identity.dataset_id,
                snapshotId=identity.snapshot_id,
                table=registered.table_name,
            )

        total_rows = self._source_row_count(relation, identity.snapshot_id)
        max_rows = int(self.settings.clickhouse_static_load_max_rows)
        if total_rows > max_rows:
            raise ClickHouseError(
                "CLICKHOUSE_STATIC_LOAD_MAX_ROWS",
                "ClickHouse static snapshot exceeds CLICKHOUSE_STATIC_LOAD_MAX_ROWS "
                f"(rows={total_rows}, limit={max_rows}).",
            )

        client.execute(
            clickhouse_static_table_ddl(
                database,
                preferred_table,
                list(identity.schema),
                order_by=list(identity.join_columns),
            )
        )
        loaded_rows = self._table_row_count(client, database, preferred_table)
        if loaded_rows != total_rows:
            self._require_load_capacity(client, total_rows)
            client.execute(
                f"TRUNCATE TABLE {qualified_clickhouse_table(database, preferred_table)}"
            )
            self._load_static_relation(
                client,
                database,
                preferred_table,
                relation,
                identity.snapshot_id,
                total_rows,
                list(identity.schema),
            )

        self._verify_static_unique_key(
            client,
            database,
            preferred_table,
            list(identity.join_columns),
            total_rows=total_rows,
        )
        self._register_snapshot(
            client,
            database,
            identity,
            preferred_table,
            total_rows,
        )
        return preferred_table

    def _source_row_count(self, relation: dict[str, Any], snapshot_id: str) -> int:
        source = static_relation_source(relation)
        count_result = execute_trino_rows(
            self.trino_client,
            f"SELECT count(*) FROM {source} FOR VERSION AS OF {int(snapshot_id)}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        if not count_result.rows or not count_result.rows[0]:
            raise ClickHouseError(
                "CLICKHOUSE_STATIC_SNAPSHOT_COUNT_UNAVAILABLE",
                "ClickHouse static snapshot count is unavailable.",
            )
        return int(count_result.rows[0][0])

    def _load_static_relation(
        self,
        client: ClickHouseClient,
        database: str,
        table: str,
        relation: dict[str, Any],
        snapshot_id: str,
        total_rows: int,
        schema: list[tuple[str, str]],
    ) -> None:
        source = static_relation_source(relation)
        columns = [item[0] for item in schema]
        projection = ", ".join(quote_trino_identifier(item) for item in columns)
        batch_size = int(self.settings.clickhouse_insert_batch_rows)
        started_at = time.perf_counter()
        log_event(
            logger,
            "clickhouse_static_cache_load_started",
            datasetId=str(relation.get("datasetId") or ""),
            snapshotId=snapshot_id,
            table=table,
            rowCount=total_rows,
        )
        page = self.trino_client.submit(
            f"SELECT {projection} FROM {source} FOR VERSION AS OF {int(snapshot_id)}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        inserted_rows = 0
        page_count = 0
        next_progress_row = 1_000_000
        while True:
            if page.error is not None:
                raise RuntimeError(f"{page.error.code}: {page.error.message}")
            for start in range(0, len(page.rows), batch_size):
                batch = page.rows[start:start + batch_size]
                inserted_rows += client.insert_json_rows(
                    database,
                    table,
                    columns,
                    batch,
                )
                if inserted_rows >= next_progress_row:
                    log_event(
                        logger,
                        "clickhouse_static_cache_load_progress",
                        datasetId=str(relation.get("datasetId") or ""),
                        snapshotId=snapshot_id,
                        table=table,
                        insertedRows=inserted_rows,
                        totalRows=total_rows,
                    )
                    next_progress_row += 1_000_000
            if not page.next_uri:
                break
            page_count += 1
            if page_count >= int(self.settings.trino_max_result_pages):
                try:
                    self.trino_client.cancel(page.next_uri, timeout_seconds=1.0)
                except Exception:
                    pass
                raise RuntimeError("ClickHouse static snapshot exceeded the Trino page limit")
            page = self.trino_client.fetch(
                page.next_uri,
                timeout_seconds=self.settings.trino_query_timeout_seconds,
            )
        if inserted_rows != total_rows:
            raise RuntimeError(
                "ClickHouse static snapshot row count mismatch: "
                f"expected={total_rows} inserted={inserted_rows}"
            )
        actual_rows = self._table_row_count(client, database, table)
        if actual_rows != total_rows:
            raise RuntimeError(
                "ClickHouse static snapshot verification failed: "
                f"expected={total_rows} actual={actual_rows}"
            )
        log_event(
            logger,
            "clickhouse_static_cache_load_completed",
            datasetId=str(relation.get("datasetId") or ""),
            snapshotId=snapshot_id,
            table=table,
            rowCount=actual_rows,
            durationMs=round((time.perf_counter() - started_at) * 1000, 2),
        )

    def _verify_static_unique_key(
        self,
        client: ClickHouseClient,
        database: str,
        table: str,
        columns: list[str],
        *,
        total_rows: int,
    ) -> None:
        if not columns:
            raise ValueError("ClickHouse static JOIN key is missing")
        target = qualified_clickhouse_table(database, table)
        quoted = [quote_clickhouse_identifier(column) for column in columns]
        invalid = " OR ".join(
            f"isNull({column}) OR empty(trimBoth(toString({column})))"
            for column in quoted
        )
        settings_clause = self._verification_settings()
        invalid_result = client.query(
            f"SELECT countIf({invalid}) AS invalid_key_rows FROM {target} "
            f"SETTINGS {settings_clause}"
        )
        invalid_rows = (
            int(invalid_result.rows[0][0] or 0)
            if invalid_result.rows and invalid_result.rows[0]
            else 0
        )
        duplicate_result = client.query(
            "SELECT 1 AS duplicate_found "
            f"FROM {target} GROUP BY {', '.join(quoted)} "
            "HAVING count() > 1 LIMIT 1 "
            f"SETTINGS optimize_aggregation_in_order = 1, {settings_clause}"
        )
        if invalid_rows or duplicate_result.rows:
            raise ClickHouseError(
                "CLICKHOUSE_STATIC_KEY_NOT_UNIQUE",
                "Pinned ClickHouse static snapshot has null, empty, or duplicate JOIN keys "
                f"(total={total_rows}, invalid={invalid_rows}, duplicate="
                f"{1 if duplicate_result.rows else 0}).",
            )

    def _verification_settings(self) -> str:
        max_memory = int(self.settings.clickhouse_static_verify_max_memory_bytes)
        max_threads = int(self.settings.clickhouse_static_verify_max_threads)
        external_group_by = max(64 * 1024 * 1024, max_memory // 2)
        return (
            f"max_threads = {max_threads}, max_memory_usage = {max_memory}, "
            f"max_bytes_before_external_group_by = {external_group_by}"
        )

    def _require_load_capacity(self, client: ClickHouseClient, total_rows: int) -> None:
        result = client.query(
            "SELECT free_space, total_space FROM system.disks "
            "WHERE name = 'default' LIMIT 1"
        )
        if not result.rows or len(result.rows[0]) < 2:
            raise ClickHouseError(
                "CLICKHOUSE_STATIC_DISK_UNKNOWN",
                "ClickHouse static snapshot load cannot verify free disk capacity.",
            )
        free_bytes = int(result.rows[0][0] or 0)
        reserve_bytes = int(self.settings.clickhouse_static_load_min_free_bytes)
        estimated_temp_bytes = max(0, int(total_rows)) * STATIC_CACHE_TEMP_BYTES_PER_ROW
        required_bytes = reserve_bytes + estimated_temp_bytes
        if free_bytes < required_bytes:
            raise ClickHouseError(
                "CLICKHOUSE_STATIC_DISK_LOW",
                "ClickHouse static snapshot load was rejected before exhausting disk "
                f"(freeBytes={free_bytes}, requiredBytes={required_bytes}).",
            )

    def _ensure_registry(self, client: ClickHouseClient, database: str) -> None:
        client.execute(
            f"CREATE TABLE IF NOT EXISTS {qualified_clickhouse_table(database, STATIC_CACHE_REGISTRY_TABLE)} "
            "(`cache_key` String, `table_name` String, `dataset_id` String, "
            "`snapshot_id` String, `schema_fingerprint` String, `row_count` UInt64, "
            "`registry_version` LowCardinality(String), `verified_at` DateTime64(3)) "
            "ENGINE = ReplacingMergeTree(verified_at) ORDER BY cache_key"
        )

    def _registered_snapshot(
        self,
        client: ClickHouseClient,
        database: str,
        cache_key: str,
    ) -> RegisteredStaticSnapshot | None:
        result = client.query(
            "SELECT table_name, row_count "
            f"FROM {qualified_clickhouse_table(database, STATIC_CACHE_REGISTRY_TABLE)} FINAL "
            f"WHERE cache_key = {quote_clickhouse_string(cache_key)} "
            f"AND registry_version = {quote_clickhouse_string(STATIC_CACHE_REGISTRY_VERSION)} "
            "LIMIT 1"
        )
        if not result.rows or len(result.rows[0]) < 2:
            return None
        return RegisteredStaticSnapshot(
            table_name=str(result.rows[0][0] or ""),
            row_count=int(result.rows[0][1] or 0),
        )

    def _register_snapshot(
        self,
        client: ClickHouseClient,
        database: str,
        identity: StaticSnapshotCacheIdentity,
        table: str,
        row_count: int,
    ) -> None:
        verified_at = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        values = ", ".join((
            quote_clickhouse_string(identity.cache_key),
            quote_clickhouse_string(table),
            quote_clickhouse_string(identity.dataset_id),
            quote_clickhouse_string(identity.snapshot_id),
            quote_clickhouse_string(identity.schema_fingerprint),
            str(max(0, int(row_count))),
            quote_clickhouse_string(STATIC_CACHE_REGISTRY_VERSION),
            quote_clickhouse_string(verified_at),
        ))
        client.execute(
            f"INSERT INTO {qualified_clickhouse_table(database, STATIC_CACHE_REGISTRY_TABLE)} "
            "(cache_key, table_name, dataset_id, snapshot_id, schema_fingerprint, "
            f"row_count, registry_version, verified_at) VALUES ({values})"
        )
        log_event(
            logger,
            "clickhouse_static_cache_registered",
            datasetId=identity.dataset_id,
            snapshotId=identity.snapshot_id,
            table=table,
            rowCount=row_count,
        )

    @staticmethod
    def _table_row_count(client: ClickHouseClient, database: str, table: str) -> int:
        result = client.query(
            f"SELECT count() AS row_count FROM {qualified_clickhouse_table(database, table)}"
        )
        return int(result.rows[0][0]) if result.rows and result.rows[0] else 0

    def _table_state(
        self,
        client: ClickHouseClient,
        database: str,
        table: str,
        schema: list[tuple[str, str]],
        row_count: int,
    ) -> str:
        exists = client.query(
            "SELECT engine FROM system.tables "
            f"WHERE database = {quote_clickhouse_string(database)} "
            f"AND name = {quote_clickhouse_string(table)} LIMIT 1"
        )
        if not exists.rows:
            return "missing"
        engine = str(exists.rows[0][0] or "")
        if "MergeTree" not in engine:
            return "mismatch"
        columns = client.query(
            "SELECT name, type FROM system.columns "
            f"WHERE database = {quote_clickhouse_string(database)} "
            f"AND table = {quote_clickhouse_string(table)} ORDER BY position"
        )
        expected = [
            [name, clickhouse_type(type_name, nullable=True)]
            for name, type_name in schema
        ]
        actual = [[str(item[0]), str(item[1])] for item in columns.rows if len(item) >= 2]
        if actual != expected:
            return "mismatch"
        return (
            "ready"
            if self._table_row_count(client, database, table) == int(row_count)
            else "mismatch"
        )


def static_snapshot_cache_identity(
    relation: dict[str, Any],
    binding: dict[str, Any],
    join_columns: list[str],
) -> StaticSnapshotCacheIdentity:
    dataset_id = str(relation.get("datasetId") or "").strip()
    snapshot_id = str(binding.get("snapshotId") or "").strip()
    schema_fingerprint = str(relation.get("schemaFingerprint") or "").strip()
    schema = tuple(referenced_relation_schema(relation))
    normalized_join_columns = tuple(str(item).strip() for item in join_columns if str(item).strip())
    if (
        not dataset_id
        or not snapshot_id.lstrip("-").isdigit()
        or not schema
        or not normalized_join_columns
    ):
        raise ValueError("ClickHouse static cache identity is incomplete")
    payload = {
        "datasetId": dataset_id,
        "joinColumns": list(normalized_join_columns),
        "queryEngineTable": relation.get("queryEngineTable") or {},
        "schema": [list(item) for item in schema],
        "schemaFingerprint": schema_fingerprint,
        "snapshotId": snapshot_id,
        "version": STATIC_CACHE_REGISTRY_VERSION,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return StaticSnapshotCacheIdentity(
        cache_key=hashlib.sha256(encoded).hexdigest(),
        dataset_id=dataset_id,
        snapshot_id=snapshot_id,
        schema_fingerprint=schema_fingerprint,
        schema=schema,
        join_columns=normalized_join_columns,
    )


def static_relation_source(relation: dict[str, Any]) -> str:
    mapping = relation.get("queryEngineTable")
    if not isinstance(mapping, dict):
        raise ValueError("ClickHouse static relation has no Iceberg mapping")
    return ".".join(
        quote_trino_identifier(mapping.get(key))
        for key in ("catalog", "schema", "table")
    )


def relation_schema(relation: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        (str(item[0]), str(item[1]))
        for item in relation.get("schema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2 and str(item[0]).strip()
    ]


def referenced_relation_schema(relation: dict[str, Any]) -> list[tuple[str, str]]:
    schema = relation_schema(relation)
    referenced = {
        normalized_column_name(item)
        for item in relation.get("referencedColumns") or []
        if normalized_column_name(item)
    }
    if not referenced:
        return schema
    selected = [item for item in schema if normalized_column_name(item[0]) in referenced]
    if len(selected) != len(referenced):
        raise ValueError("ClickHouse static relation references an unknown column")
    return selected


def clickhouse_static_table_ddl(
    database: str,
    table: str,
    schema: list[Any],
    *,
    order_by: list[str] | None = None,
) -> str:
    definitions = [
        f"{quote_clickhouse_identifier(str(item[0]))} "
        f"{clickhouse_type(str(item[1]), nullable=True)}"
        for item in schema
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    if not definitions:
        raise ValueError("ClickHouse static relation schema is empty")
    sort_key = (
        f"({', '.join(quote_clickhouse_identifier(item) for item in order_by)})"
        if order_by
        else "tuple()"
    )
    settings_clause = " SETTINGS allow_nullable_key = 1" if order_by else ""
    return (
        f"CREATE TABLE IF NOT EXISTS {qualified_clickhouse_table(database, table)} "
        f"({', '.join(definitions)}) ENGINE = MergeTree ORDER BY {sort_key}"
        f"{settings_clause}"
    )


def clickhouse_type(type_name: str, *, nullable: bool) -> str:
    normalized = re.sub(r"\s+", "", str(type_name or "string").casefold())
    if normalized.startswith("decimal") or normalized == "numeric":
        base = "Decimal(38, 9)"
    elif normalized in {"tinyint", "smallint", "integer", "int", "int32"}:
        base = "Int32"
    elif normalized in {"bigint", "long", "int64"}:
        base = "Int64"
    elif normalized in {"real", "float", "float32", "double", "float64"}:
        base = "Float64"
    elif normalized in {"boolean", "bool"}:
        base = "Bool"
    elif normalized in {"timestamp", "datetime", "timestampwithtimezone"}:
        base = "DateTime64(3)"
    elif normalized == "date":
        base = "Date"
    else:
        base = "String"
    return f"Nullable({base})" if nullable else base


def normalized_column_name(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().strip('"`')).casefold()
