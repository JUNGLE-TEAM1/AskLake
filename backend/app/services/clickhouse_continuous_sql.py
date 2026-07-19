from __future__ import annotations

import hashlib
import re
from typing import Any, Callable

from fastapi import status
import sqlglot
from sqlglot import expressions as exp
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
            binding = static_bindings.get(str(relation.get("datasetId") or ""))
            if binding is None:
                raise ValueError("Pinned ClickHouse static relation binding is missing")
            table_name = clickhouse_static_runtime_table(names["prefix"], index, binding)
            static_tables[str(relation.get("runtimeView") or "")] = table_name
            schema = referenced_relation_schema(relation)
            join_columns = continuous_sql_static_join_columns(
                job,
                str(relation.get("datasetId") or ""),
            )
            client.execute(
                clickhouse_static_table_ddl(
                    target.database,
                    table_name,
                    schema,
                    order_by=join_columns,
                )
            )
            self._load_static_relation(client, target.database, table_name, relation, binding)
            self._verify_static_unique_key(
                client,
                target.database,
                table_name,
                join_columns,
            )

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
            output_schema=list(job.compiled_plan.get("outputSchema") or []),
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
        columns = [str(item[0]) for item in referenced_relation_schema(relation)]
        if not columns:
            raise ValueError("ClickHouse static relation schema is empty")
        source = ".".join(
            quote_trino_identifier(mapping.get(key))
            for key in ("catalog", "schema", "table")
        )
        projection = ", ".join(quote_trino_identifier(item) for item in columns)
        count_result = execute_trino_rows(
            self.trino_client,
            f"SELECT count(*) FROM {source} FOR VERSION AS OF {int(snapshot_id)}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        if not count_result.rows or not count_result.rows[0]:
            raise ValueError("ClickHouse static snapshot count is unavailable")
        total_rows = int(count_result.rows[0][0])
        target = qualified_clickhouse_table(database, table)
        existing_count = client.query(f"SELECT count() AS row_count FROM {target}")
        loaded_rows = int(existing_count.rows[0][0]) if existing_count.rows else 0
        if loaded_rows == total_rows:
            return
        client.execute(f"TRUNCATE TABLE {target}")
        if total_rows == 0:
            return

        batch_size = int(self.settings.clickhouse_insert_batch_rows)
        page = self.trino_client.submit(
            f"SELECT {projection} FROM {source} FOR VERSION AS OF {int(snapshot_id)}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        inserted_rows = 0
        page_count = 0
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
                f"ClickHouse static snapshot row count mismatch: expected={total_rows} inserted={inserted_rows}"
            )
        verified_count = client.query(f"SELECT count() AS row_count FROM {target}")
        actual_rows = int(verified_count.rows[0][0]) if verified_count.rows else 0
        if actual_rows != total_rows:
            raise RuntimeError(
                f"ClickHouse static snapshot verification failed: expected={total_rows} actual={actual_rows}"
            )

    @staticmethod
    def _verify_static_unique_key(
        client: ClickHouseClient,
        database: str,
        table: str,
        columns: list[str],
    ) -> None:
        if not columns:
            raise ValueError("ClickHouse static JOIN key is missing")
        quoted = [quote_clickhouse_identifier(column) for column in columns]
        invalid = " OR ".join(
            f"isNull({column}) OR empty(trimBoth(toString({column})))"
            for column in quoted
        )
        key = f"tuple({', '.join(quoted)})"
        result = client.query(
            "SELECT count() AS total_rows, "
            f"countIf({invalid}) AS invalid_key_rows, "
            f"uniqExact({key}) AS distinct_keys "
            f"FROM {qualified_clickhouse_table(database, table)}"
        )
        if not result.rows or len(result.rows[0]) < 3:
            raise RuntimeError("ClickHouse static key verification returned no result")
        total_rows, invalid_rows, distinct_keys = (int(value or 0) for value in result.rows[0][:3])
        if invalid_rows or total_rows != distinct_keys:
            raise ClickHouseError(
                "CLICKHOUSE_STATIC_KEY_NOT_UNIQUE",
                "Pinned ClickHouse static snapshot has null, empty, or duplicate JOIN keys "
                f"(total={total_rows}, invalid={invalid_rows}, distinct={distinct_keys}).",
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
            f"{quote_clickhouse_string(names['kafka'])}, "
            f"{quote_clickhouse_string(names['raw'])}, "
            f"{quote_clickhouse_string(target.table)})"
        )
        existing = {str(row[0]) for row in tables.rows if row}
        if target.table not in existing or names["raw"] not in existing:
            return self._worker_result(job, target, "missing")
        runtime_tables = {names["kafka"], names["ingest_view"], names["join_view"]}
        state = "not_running"
        last_error_code: str | None = None
        last_error_message: str | None = None
        consumer_messages_read = 0
        if runtime_tables.issubset(existing):
            consumers = client.query(
                "SELECT is_currently_used, num_messages_read, "
                "arrayStringConcat(arrayMap(item -> toString(tupleElement(item, 2)), exceptions), '\\n') "
                "AS exception_text, "
                "toUnixTimestamp64Milli(toDateTime64(last_poll_time, 3)) AS last_poll_ms, "
                "if(empty(exceptions), 0, toUnixTimestamp64Milli(toDateTime64("
                "tupleElement(arrayElement(exceptions, -1), 1), 3))) AS last_exception_ms "
                "FROM system.kafka_consumers "
                f"WHERE database = {quote_clickhouse_string(target.database)} "
                f"AND table = {quote_clickhouse_string(names['kafka'])}"
            )
            if not consumers.rows:
                state = "starting"
            else:
                row = consumers.rows[0]
                consumer_messages_read = int(row[1] or 0) if len(row) > 1 else 0
                consumer_error = str(row[2] or "").strip() if len(row) > 2 else ""
                last_poll_ms = int(row[3] or 0) if len(row) > 3 else 0
                last_exception_ms = int(row[4] or 0) if len(row) > 4 else 0
                if consumer_error and last_exception_ms >= last_poll_ms:
                    state = "failed"
                    last_error_code = "CLICKHOUSE_KAFKA_CONSUMER_ERROR"
                    last_error_message = consumer_error[:1000]
                else:
                    state = "running" if clickhouse_truthy(row[0]) else "starting"
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
            consumer_messages_read=consumer_messages_read,
            last_error_code=last_error_code,
            last_error_message=last_error_message,
        )

    @staticmethod
    def _worker_result(
        job: ContinuousSqlJobModel,
        target: ClickHouseWriterTarget,
        state: str,
        *,
        offsets: list[dict[str, Any]] | None = None,
        output_row_count: int | None = None,
        consumer_messages_read: int = 0,
        last_error_code: str | None = None,
        last_error_message: str | None = None,
    ) -> dict[str, Any]:
        return {
            "containerState": state,
            "workerAttemptId": f"clickhouse:{target.database}.{target.table}",
            "clickhouseOffsets": offsets or [],
            "servingMode": "clickhouse",
            "jobId": job.id,
            "clickhouseOutputRowCount": max(0, int(output_row_count or 0)),
            "consumerMessagesRead": max(0, int(consumer_messages_read or 0)),
            "lastErrorCode": last_error_code,
            "lastErrorMessage": last_error_message,
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
        raise ValueError("ClickHouse static table schema is empty")
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
    schema = relation_schema(stream)
    if not schema:
        raise ValueError("ClickHouse Kafka ingest projection is empty")
    source = stream.get("streamingSource")
    if not isinstance(source, dict):
        raise ValueError("ClickHouse Kafka source configuration is missing")
    record_parsing = source.get("recordParsing")
    record_parsing = record_parsing if isinstance(record_parsing, dict) else {}
    schema_columns = [item for item in source.get("schemaColumns") or [] if isinstance(item, dict)]
    projection: list[str] = []
    with_clause = ""
    if record_parsing.get("enabled") is True:
        if str(record_parsing.get("delimiterKind") or "whitespace") != "whitespace":
            raise ValueError("ClickHouse Kafka ingest supports only whitespace record parsing")
        if record_parsing.get("header") is True:
            raise ValueError("ClickHouse Kafka ingest does not support header rows")
        parsing_columns = sorted(
            [item for item in record_parsing.get("columns") or [] if isinstance(item, dict)],
            key=lambda item: int(item.get("position") or 0),
        )
        expected = int(record_parsing.get("expectedFieldCount") or 0)
        if expected <= 0 or len(parsing_columns) != expected:
            raise ValueError("ClickHouse Kafka record parsing contract is invalid")
        parsing_positions = [int(item.get("position") or 0) for item in parsing_columns]
        parsing_names = [normalized_column_name(item.get("name")) for item in parsing_columns]
        if (
            parsing_positions != list(range(expected))
            or any(not item for item in parsing_names)
            or len(set(parsing_names)) != expected
        ):
            raise ValueError("ClickHouse Kafka record parsing positions and names must be unique")
        positions = {
            normalized_column_name(item.get("name")): int(item.get("position") or 0) + 1
            for item in parsing_columns
            if normalized_column_name(item.get("name"))
        }
        source_names = stream_source_names(schema_columns)
        for name, type_name in schema:
            source_name = source_names.get(normalized_column_name(name), name)
            position = positions.get(normalized_column_name(source_name))
            if position is None:
                raise ValueError(f"Kafka record parsing column is missing: {source_name}")
            projection.append(
                clickhouse_safe_cast(f"_record_fields[{position}]", type_name, name)
            )
        delimiter = str(record_parsing.get("delimiterPattern") or r"\s+")
        if delimiter != r"\s+":
            raise ValueError("ClickHouse Kafka ingest requires the \\s+ delimiter pattern")
        with_clause = (
            f"WITH splitByRegexp({quote_clickhouse_string(delimiter)}, trimBoth(_raw_message)) "
            "AS _record_fields "
        )
        validity = (
            f"throwIf(length(_record_fields) != {expected}, "
            f"{quote_clickhouse_string(f'Kafka record field count must equal {expected}')}) = 0"
        )
    else:
        source_names = stream_source_names(schema_columns)
        for name, type_name in schema:
            source_name = source_names.get(normalized_column_name(name), name)
            projection.append(
                clickhouse_safe_cast(clickhouse_json_value(source_name), type_name, name)
            )
        validity = (
            "throwIf(NOT isValidJSON(_raw_message), "
            f"{quote_clickhouse_string('Kafka message must be valid JSON')}) = 0"
        )
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
        f"{with_clause}SELECT {', '.join(projection)} "
        f"FROM {qualified_clickhouse_table(database, kafka_table)} "
        f"WHERE {validity}"
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
    if not relation_schema(stream):
        raise ValueError("ClickHouse Kafka relation schema is empty")
    group = f"asklake_clickhouse_{hashlib.sha256(job.id.encode('utf-8')).hexdigest()[:24]}"
    return (
        f"CREATE TABLE {qualified_clickhouse_table(target.database, table)} "
        "(`_raw_message` String) ENGINE = Kafka SETTINGS "
        f"kafka_broker_list = {quote_clickhouse_string(broker)}, "
        f"kafka_topic_list = {quote_clickhouse_string(topic)}, "
        f"kafka_group_name = {quote_clickhouse_string(group)}, "
        "kafka_format = 'RawBLOB', kafka_num_consumers = 1, "
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
    output_schema: list[Any] | None = None,
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
    expression = sqlglot.parse_one(transpiled[0], read="clickhouse")
    if not isinstance(expression, exp.Select):
        raise ValueError("ClickHouse runtime SQL must be a SELECT")
    output_names = [
        str(item[0])
        for item in output_schema or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    ]
    projections = list(expression.expressions)
    if output_names and len(projections) < len(output_names):
        raise ValueError("ClickHouse runtime SQL output does not match the output schema")
    for index, output_name in enumerate(output_names):
        projection = projections[index]
        source_expression = projection.this if isinstance(projection, exp.Alias) else projection
        projections[index] = exp.alias_(source_expression.copy(), output_name, quoted=True)
    expression.set("expressions", projections)
    return expression.sql(dialect="clickhouse")


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


def clickhouse_static_runtime_table(
    prefix: str,
    index: int,
    binding: dict[str, Any],
) -> str:
    snapshot_id = str(binding.get("snapshotId") or "").strip()
    if not snapshot_id:
        raise ValueError("Pinned ClickHouse static relation snapshot is missing")
    digest = hashlib.sha256(snapshot_id.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_static_{index}_{digest}"


def continuous_sql_static_join_columns(
    job: ContinuousSqlJobModel,
    dataset_id: str,
) -> list[str]:
    columns: list[str] = []
    for join in job.compiled_plan.get("joins") or []:
        if not isinstance(join, dict) or str(join.get("rightDatasetId") or "") != dataset_id:
            continue
        for key in join.get("keys") or []:
            if not isinstance(key, dict):
                continue
            column = str(key.get("rightColumn") or "").strip()
            if column and column not in columns:
                columns.append(column)
    if not columns:
        raise ValueError("ClickHouse static relation has no compiled JOIN key")
    return columns


def stream_source_names(schema_columns: list[dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in schema_columns:
        if item.get("included") is False:
            continue
        target_name = str(item.get("targetName") or "").strip()
        source_name = str(item.get("sourceName") or target_name).strip()
        if target_name and source_name:
            result[normalized_column_name(target_name)] = source_name
    return result


def clickhouse_json_value(source_name: str) -> str:
    components = [item for item in str(source_name or "").split(".") if item]
    if not components:
        raise ValueError("ClickHouse Kafka JSON source path is empty")
    path = "$" + "".join(
        f'."{item.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"'
        for item in components
    )
    return f"JSON_VALUE(_raw_message, {quote_clickhouse_string(path)})"


def clickhouse_safe_cast(value: str, type_name: str, alias: str) -> str:
    normalized = re.sub(r"\s+", "", str(type_name or "string").casefold())
    nullable_value = f"nullIf({value}, '')"
    if normalized in {"tinyint", "smallint", "integer", "int", "int32"}:
        expression = f"toInt32OrNull({nullable_value})"
    elif normalized in {"bigint", "long", "int64"}:
        expression = f"toInt64OrNull({nullable_value})"
    elif normalized in {"real", "float", "float32", "double", "float64"}:
        expression = f"toFloat64OrNull({nullable_value})"
    elif normalized in {"boolean", "bool"}:
        expression = f"accurateCastOrNull({nullable_value}, 'Bool')"
    elif normalized in {"timestamp", "datetime", "timestampwithtimezone"}:
        expression = f"parseDateTime64BestEffortOrNull({nullable_value}, 3)"
    elif normalized == "date":
        expression = f"toDateOrNull({nullable_value})"
    elif normalized.startswith("decimal") or normalized == "numeric":
        expression = f"toDecimal128OrNull({nullable_value}, 9)"
    else:
        expression = nullable_value
    return f"{expression} AS {quote_clickhouse_identifier(alias)}"


def normalized_column_name(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().strip('"`')).casefold()


def clickhouse_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().casefold() in {"1", "true", "yes"}


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
