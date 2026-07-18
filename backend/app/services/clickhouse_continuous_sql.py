from __future__ import annotations

import hashlib
import re
from typing import Any, Callable

from fastapi import status
import sqlglot
from sqlglot.errors import SqlglotError

from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.schemas.continuous_sql import ClickHouseWriterTarget
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    quote_clickhouse_identifier,
    quote_clickhouse_string,
)
from app.services.iceberg_dataset_reader import execute_trino_rows, quote_trino_identifier
from app.services.trino_client import TrinoClient


ClientFactory = Callable[[], ClickHouseClient]


class ClickHouseContinuousSqlWorkerGateway:
    """Provision and control a Kafka Engine -> JOIN MV -> MergeTree hot path."""

    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        client_factory: ClientFactory | None = None,
        trino_client: TrinoClient | None = None,
    ) -> None:
        self.settings = runtime_settings or settings
        self.client_factory = client_factory or (
            lambda: ClickHouseClient(self.settings)
        )
        self.trino_client = trino_client or TrinoClient(self.settings)

    def manage(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del options
        target = ClickHouseWriterTarget.model_validate(job.output_target)
        client = self.client_factory()
        try:
            if action == "start":
                if run is None:
                    raise ValueError("ClickHouse Continuous SQL start requires an active run")
                self._provision(client, job, run, target)
                return self._status(client, job, target)
            if action == "status":
                return self._status(client, job, target)
            if action == "pause":
                self._stop(client, job, target)
                return self._worker_result(job, target, "not_running")
            if action in {"stop", "terminate"}:
                self._stop(client, job, target)
                return self._worker_result(job, target, "not_running")
            if action == "ack":
                return self._worker_result(job, target, "running")
            raise ValueError(f"Unsupported ClickHouse Continuous SQL action: {action}")
        except ApiError:
            raise
        except (ClickHouseError, RuntimeError, ValueError, SqlglotError) as exc:
            code = getattr(exc, "code", "CLICKHOUSE_CONTINUOUS_SQL_FAILED")
            raise ApiError(
                str(code),
                str(exc)[:1000],
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"jobId": job.id, "action": action},
            ) from exc
        finally:
            client.close()

    def _provision(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        target: ClickHouseWriterTarget,
    ) -> None:
        names = clickhouse_runtime_names(job.id)
        client.execute(
            f"CREATE DATABASE IF NOT EXISTS {quote_clickhouse_identifier(target.database)}"
        )
        for view_name in (names["ingest_view"], names["join_view"]):
            client.execute(
                f"DROP TABLE IF EXISTS {qualified_clickhouse_table(target.database, view_name)}"
            )
        client.execute(
            clickhouse_output_table_ddl(target, list(job.compiled_plan.get("outputSchema") or []))
        )

        static_tables: dict[str, str] = {}
        static_bindings = {
            str(item.get("datasetId") or ""): item
            for item in run.static_bindings or []
            if isinstance(item, dict)
        }
        for index, relation in enumerate(job.relation_bindings or []):
            if not isinstance(relation, dict) or relation.get("mode") != "static":
                continue
            table_name = f"{names['prefix']}_static_{index}"
            static_tables[str(relation.get("runtimeView") or "")] = table_name
            client.execute(
                f"DROP TABLE IF EXISTS {qualified_clickhouse_table(target.database, table_name)}"
            )
            schema = list(relation.get("schema") or [])
            client.execute(clickhouse_static_table_ddl(target.database, table_name, schema))
            binding = static_bindings.get(str(relation.get("datasetId") or ""))
            if binding is None:
                raise ValueError("Pinned ClickHouse static relation binding is missing")
            self._load_static_relation(client, target.database, table_name, relation, binding)

        client.execute(
            f"DROP TABLE IF EXISTS {qualified_clickhouse_table(target.database, names['kafka'])}"
        )
        stream = next(
            (
                item
                for item in job.relation_bindings or []
                if isinstance(item, dict) and item.get("mode") == "streaming"
            ),
            None,
        )
        if stream is None:
            raise ValueError("ClickHouse Continuous SQL streaming relation is missing")
        client.execute(clickhouse_raw_table_ddl(target.database, names["raw"], stream))
        client.execute(clickhouse_kafka_table_ddl(job, target, names["kafka"], stream))
        select_sql = clickhouse_runtime_sql(
            str(job.compiled_plan.get("runtimeSql") or ""),
            stream_relation=stream,
            database=target.database,
            stream_table=names["raw"],
            static_tables=static_tables,
        )
        client.execute(
            "CREATE MATERIALIZED VIEW "
            f"{qualified_clickhouse_table(target.database, names['join_view'])} "
            f"TO {qualified_clickhouse_table(target.database, target.table)} AS {select_sql}"
        )
        client.execute(
            clickhouse_ingest_materialized_view_ddl(
                target.database,
                names["ingest_view"],
                names["kafka"],
                names["raw"],
                stream,
            )
        )

    def _load_static_relation(
        self,
        client: ClickHouseClient,
        database: str,
        table: str,
        relation: dict[str, Any],
        binding: dict[str, Any],
    ) -> None:
        mapping = relation.get("queryEngineTable")
        if not isinstance(mapping, dict):
            raise ValueError("ClickHouse static relation has no Iceberg mapping")
        snapshot_id = str(binding.get("snapshotId") or "").strip()
        if not snapshot_id.lstrip("-").isdigit():
            raise ValueError("ClickHouse static relation snapshot is invalid")
        columns = [
            str(item[0])
            for item in relation.get("schema") or []
            if isinstance(item, (list, tuple)) and len(item) >= 2
        ]
        if not columns:
            raise ValueError("ClickHouse static relation schema is empty")
        source = ".".join(
            quote_trino_identifier(mapping.get(key))
            for key in ("catalog", "schema", "table")
        )
        projection = ", ".join(quote_trino_identifier(item) for item in columns)
        max_rows = int(self.settings.clickhouse_static_load_max_rows)
        count_result = execute_trino_rows(
            self.trino_client,
            f"SELECT count(*) FROM {source} FOR VERSION AS OF {int(snapshot_id)}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        total_rows = int(count_result.rows[0][0]) if count_result.rows and count_result.rows[0] else 0
        if total_rows > max_rows:
            raise ValueError(
                "ClickHouse static snapshot exceeds CLICKHOUSE_STATIC_LOAD_MAX_ROWS"
            )
        batch_size = int(self.settings.clickhouse_insert_batch_rows)
        page = self.trino_client.submit(
            f"SELECT {projection} FROM {source} FOR VERSION AS OF {int(snapshot_id)}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        while True:
            if page.error is not None:
                raise RuntimeError(f"{page.error.code}: {page.error.message}")
            for start in range(0, len(page.rows), batch_size):
                client.insert_json_rows(
                    database,
                    table,
                    columns,
                    page.rows[start:start + batch_size],
                )
            if not page.next_uri:
                break
            page = self.trino_client.fetch(
                page.next_uri,
                timeout_seconds=self.settings.trino_query_timeout_seconds,
            )

    def _stop(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        target: ClickHouseWriterTarget,
    ) -> None:
        names = clickhouse_runtime_names(job.id)
        for view_name in (names["ingest_view"], names["join_view"]):
            client.execute(
                f"DROP TABLE IF EXISTS {qualified_clickhouse_table(target.database, view_name)}"
            )
        client.execute(
            f"DROP TABLE IF EXISTS {qualified_clickhouse_table(target.database, names['kafka'])}"
        )

    def _status(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        target: ClickHouseWriterTarget,
    ) -> dict[str, Any]:
        names = clickhouse_runtime_names(job.id)
        tables = client.query(
            "SELECT name FROM system.tables "
            f"WHERE database = {quote_clickhouse_string(target.database)} "
            "AND name IN ("
            f"{quote_clickhouse_string(names['ingest_view'])}, "
            f"{quote_clickhouse_string(names['join_view'])}, "
            f"{quote_clickhouse_string(names['raw'])}, "
            f"{quote_clickhouse_string(target.table)})"
        )
        existing = {str(row[0]) for row in tables.rows if row}
        if target.table not in existing or names["raw"] not in existing:
            return self._worker_result(job, target, "missing")
        state = (
            "running"
            if {names["ingest_view"], names["join_view"]}.issubset(existing)
            else "not_running"
        )
        progress = client.query(
            "SELECT kafka_partition, min(kafka_offset) AS min_offset, "
            "max(kafka_offset) AS max_offset, count() AS row_count, "
            "max(ingested_at) AS latest_ingested_at "
            f"FROM {qualified_clickhouse_table(target.database, names['raw'])} FINAL "
            "GROUP BY kafka_partition ORDER BY kafka_partition"
        )
        output_count_result = client.query(
            "SELECT count() AS row_count "
            f"FROM {qualified_clickhouse_table(target.database, target.table)} FINAL"
        )
        output_row_count = (
            int(output_count_result.rows[0][0])
            if output_count_result.rows
            else 0
        )
        offsets = [
            {
                "partition": int(row[0]),
                "minOffset": int(row[1]),
                "maxOffset": int(row[2]),
                "rowCount": int(row[3]),
                "latestIngestedAt": str(row[4] or ""),
            }
            for row in progress.rows
            if len(row) >= 5
        ]
        return self._worker_result(
            job,
            target,
            state,
            offsets=offsets,
            output_row_count=output_row_count,
        )

    @staticmethod
    def _worker_result(
        job: ContinuousSqlJobModel,
        target: ClickHouseWriterTarget,
        state: str,
        *,
        offsets: list[dict[str, Any]] | None = None,
        output_row_count: int | None = None,
    ) -> dict[str, Any]:
        return {
            "containerState": state,
            "workerAttemptId": f"clickhouse:{target.database}.{target.table}",
            "clickhouseOffsets": offsets or [],
            "servingMode": "clickhouse",
            "jobId": job.id,
            "clickhouseOutputRowCount": max(0, int(output_row_count or 0)),
        }


def clickhouse_runtime_names(job_id: str) -> dict[str, str]:
    digest = hashlib.sha256(str(job_id).encode("utf-8")).hexdigest()[:16]
    prefix = f"asklake_{digest}"
    return {
        "prefix": prefix,
        "kafka": f"{prefix}_kafka",
        "raw": f"{prefix}_raw",
        "ingest_view": f"{prefix}_ingest_mv",
        "join_view": f"{prefix}_join_mv",
        "view": f"{prefix}_join_mv",
    }


def clickhouse_output_table_ddl(
    target: ClickHouseWriterTarget,
    output_schema: list[Any],
) -> str:
    columns = [
        (
            str(item[0]),
            clickhouse_type(str(item[1]), nullable=True),
        )
        for item in output_schema
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    if not columns:
        raise ValueError("ClickHouse output schema is empty")
    definitions = [
        f"{quote_clickhouse_identifier(name)} {type_name}"
        for name, type_name in columns
    ]
    definitions.extend((
        "`kafka_timestamp` Nullable(DateTime64(3))",
        "`kafka_partition` Int64",
        "`kafka_offset` Int64",
        "`ingested_at` DateTime64(3)",
    ))
    return (
        f"CREATE TABLE IF NOT EXISTS {qualified_clickhouse_table(target.database, target.table)} "
        f"({', '.join(definitions)}) "
        "ENGINE = ReplacingMergeTree(ingested_at) "
        "ORDER BY (kafka_partition, kafka_offset)"
    )


def clickhouse_static_table_ddl(database: str, table: str, schema: list[Any]) -> str:
    definitions = [
        f"{quote_clickhouse_identifier(str(item[0]))} "
        f"{clickhouse_type(str(item[1]), nullable=True)}"
        for item in schema
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    if not definitions:
        raise ValueError("ClickHouse static table schema is empty")
    return (
        f"CREATE TABLE {qualified_clickhouse_table(database, table)} "
        f"({', '.join(definitions)}) ENGINE = MergeTree ORDER BY tuple()"
    )


def clickhouse_raw_table_ddl(
    database: str,
    table: str,
    stream: dict[str, Any],
) -> str:
    definitions = [
        f"{quote_clickhouse_identifier(str(item[0]))} "
        f"{clickhouse_type(str(item[1]), nullable=True)}"
        for item in stream.get("schema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    if not definitions:
        raise ValueError("ClickHouse raw Kafka relation schema is empty")
    definitions.extend((
        "`kafka_timestamp` Nullable(DateTime64(3))",
        "`kafka_partition` Int64",
        "`kafka_offset` Int64",
        "`ingested_at` DateTime64(3)",
    ))
    return (
        f"CREATE TABLE IF NOT EXISTS {qualified_clickhouse_table(database, table)} "
        f"({', '.join(definitions)}) "
        "ENGINE = ReplacingMergeTree(ingested_at) "
        "ORDER BY (kafka_partition, kafka_offset)"
    )


def clickhouse_ingest_materialized_view_ddl(
    database: str,
    view: str,
    kafka_table: str,
    raw_table: str,
    stream: dict[str, Any],
) -> str:
    columns = [
        str(item[0])
        for item in stream.get("schema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    if not columns:
        raise ValueError("ClickHouse Kafka ingest projection is empty")
    projection = [quote_clickhouse_identifier(column) for column in columns]
    projection.extend((
        "_timestamp_ms AS kafka_timestamp",
        "_partition AS kafka_partition",
        "_offset AS kafka_offset",
        "now64(3) AS ingested_at",
    ))
    return (
        "CREATE MATERIALIZED VIEW "
        f"{qualified_clickhouse_table(database, view)} "
        f"TO {qualified_clickhouse_table(database, raw_table)} AS "
        f"SELECT {', '.join(projection)} "
        f"FROM {qualified_clickhouse_table(database, kafka_table)}"
    )


def clickhouse_kafka_table_ddl(
    job: ContinuousSqlJobModel,
    target: ClickHouseWriterTarget,
    table: str,
    stream: dict[str, Any],
) -> str:
    source = stream.get("streamingSource")
    if not isinstance(source, dict):
        raise ValueError("ClickHouse Kafka source configuration is missing")
    broker = str(source.get("broker") or "").strip()
    topic = str(source.get("topic") or "").strip()
    if not broker or not topic:
        raise ValueError("ClickHouse Kafka broker and topic are required")
    definitions = [
        f"{quote_clickhouse_identifier(str(item[0]))} "
        f"{clickhouse_type(str(item[1]), nullable=True)}"
        for item in stream.get("schema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    if not definitions:
        raise ValueError("ClickHouse Kafka relation schema is empty")
    group = f"asklake_clickhouse_{hashlib.sha256(job.id.encode('utf-8')).hexdigest()[:24]}"
    return (
        f"CREATE TABLE {qualified_clickhouse_table(target.database, table)} "
        f"({', '.join(definitions)}) ENGINE = Kafka SETTINGS "
        f"kafka_broker_list = {quote_clickhouse_string(broker)}, "
        f"kafka_topic_list = {quote_clickhouse_string(topic)}, "
        f"kafka_group_name = {quote_clickhouse_string(group)}, "
        "kafka_format = 'JSONEachRow', kafka_num_consumers = 1, "
        "kafka_skip_broken_messages = 0, kafka_commit_every_batch = 1, "
        "kafka_max_block_size = 1000, kafka_poll_timeout_ms = 100, "
        "kafka_flush_interval_ms = 250"
    )


def clickhouse_runtime_sql(
    runtime_sql: str,
    *,
    stream_relation: dict[str, Any],
    database: str,
    kafka_table: str | None = None,
    stream_table: str | None = None,
    static_tables: dict[str, str],
) -> str:
    if not runtime_sql.strip():
        raise ValueError("ClickHouse runtime SQL is missing")
    if bool(kafka_table) == bool(stream_table):
        raise ValueError("ClickHouse runtime requires exactly one streaming table")
    rewritten = runtime_sql
    stream_view = str(stream_relation.get("runtimeView") or "")
    rewritten = replace_runtime_table(
        rewritten,
        stream_view,
        qualified_clickhouse_table(database, kafka_table or stream_table),
    )
    for runtime_view, table in static_tables.items():
        rewritten = replace_runtime_table(
            rewritten,
            runtime_view,
            qualified_clickhouse_table(database, table),
        )
    alias = re.escape(str(stream_relation.get("alias") or ""))
    if not alias:
        raise ValueError("ClickHouse streaming relation alias is missing")
    if kafka_table is not None:
        metadata_replacements = {
            "kafka_timestamp": "_timestamp_ms",
            "kafka_partition": "_partition",
            "kafka_offset": "_offset",
        }
        for logical, physical in metadata_replacements.items():
            rewritten = re.sub(
                rf"\b{alias}\.{re.escape(logical)}\b",
                f"{stream_relation['alias']}.{physical}",
                rewritten,
                flags=re.IGNORECASE,
            )
        rewritten = re.sub(
            rf"\b{alias}\.ingested_at\b",
            "now64(3)",
            rewritten,
            flags=re.IGNORECASE,
        )
    transpiled = sqlglot.transpile(rewritten, read="spark", write="clickhouse")
    if len(transpiled) != 1:
        raise ValueError("ClickHouse runtime SQL must contain exactly one statement")
    return transpiled[0]


def replace_runtime_table(query: str, runtime_view: str, target: str) -> str:
    if not runtime_view:
        raise ValueError("ClickHouse runtime relation name is missing")
    escaped = re.escape(runtime_view)
    pattern = rf"(?<![A-Za-z0-9_])(?:`{escaped}`|\"{escaped}\"|{escaped})(?![A-Za-z0-9_])"
    replaced, count = re.subn(pattern, target, query, flags=re.IGNORECASE)
    if count == 0:
        raise ValueError(f"ClickHouse runtime relation was not found: {runtime_view}")
    return replaced


def clickhouse_type(type_name: str, *, nullable: bool) -> str:
    normalized = re.sub(r"\s+", "", str(type_name or "string").casefold())
    if normalized in {"tinyint", "smallint", "integer", "int", "int32"}:
        result = "Int32"
    elif normalized in {"bigint", "long", "int64"}:
        result = "Int64"
    elif normalized in {"real", "float", "float32", "double", "float64"}:
        result = "Float64"
    elif normalized in {"boolean", "bool"}:
        result = "Bool"
    elif normalized in {"timestamp", "datetime", "timestampwithtimezone"}:
        result = "DateTime64(3)"
    elif normalized == "date":
        result = "Date"
    elif normalized.startswith("decimal") or normalized in {"numeric"}:
        result = "Decimal(38, 9)"
    else:
        result = "String"
    return f"Nullable({result})" if nullable else result
