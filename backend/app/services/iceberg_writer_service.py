from __future__ import annotations

from typing import Any

from sqlglot import exp, parse
from sqlglot.errors import ParseError

from app.core.config import Settings, settings
from app.schemas.iceberg import (
    IcebergCommitEvidence,
    IcebergWriteMode,
    IcebergWriterTarget,
)
from app.schemas.trino import TrinoClientPage
from app.services.query_engine_registration_service import physical_table_name
from app.services.trino_client import TrinoClient


class IcebergWriterError(RuntimeError):
    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


def build_iceberg_writer_target(
    display_name: str,
    dataset_id: str,
    *,
    write_mode: IcebergWriteMode,
    partition_columns: list[str] | None = None,
    runtime_settings: Settings | None = None,
) -> IcebergWriterTarget:
    config = runtime_settings or settings
    return IcebergWriterTarget(
        catalog=config.trino_catalog,
        namespace=config.trino_schema,
        table=physical_table_name(display_name, dataset_id),
        write_mode=write_mode,
        partition_columns=partition_columns or [],
    )


def writer_mode_for_source(source_type: str) -> IcebergWriteMode:
    return "append" if "kafka" in str(source_type or "").casefold() else "replace"


class IcebergWriterService:
    """Backend-owned Trino adapter for atomic Iceberg commits and evidence."""

    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        client: TrinoClient | None = None,
    ) -> None:
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(
            self.settings,
            username=self.settings.trino_materializer_username,
            password=self.settings.trino_materializer_password,
        )

    def commit_select(
        self,
        target: IcebergWriterTarget,
        select_sql: str,
        *,
        job_id: str,
        run_id: str,
        schema_fingerprint: str | None = None,
        rule_fingerprint: str | None = None,
        source_boundary: dict[str, Any] | None = None,
    ) -> IcebergCommitEvidence:
        source_query = trusted_select_sql(select_sql)
        self.ensure_namespace(target)
        existed_before = self.table_exists(target)
        self._execute(self._commit_statement(target, source_query, existed_before=existed_before))
        return self.verify_commit(
            target,
            created_table=not existed_before,
            job_id=job_id,
            run_id=run_id,
            schema_fingerprint=schema_fingerprint,
            rule_fingerprint=rule_fingerprint,
            source_boundary=source_boundary,
        )

    def verify_commit(
        self,
        target: IcebergWriterTarget,
        *,
        created_table: bool,
        job_id: str,
        run_id: str,
        expected_snapshot_id: str | None = None,
        schema_fingerprint: str | None = None,
        rule_fingerprint: str | None = None,
        source_boundary: dict[str, Any] | None = None,
    ) -> IcebergCommitEvidence:
        self.describe_table(target)
        if expected_snapshot_id is not None:
            try:
                snapshot_id, committed_at, warehouse_location = self.snapshot(
                    target,
                    str(expected_snapshot_id),
                )
            except IcebergWriterError as exc:
                if exc.code == "ICEBERG_SNAPSHOT_EVIDENCE_MISSING":
                    raise IcebergWriterError("ICEBERG_SNAPSHOT_ID_MISMATCH") from exc
                raise
        else:
            snapshot_id, committed_at, warehouse_location = self.current_snapshot(target)
        if expected_snapshot_id is not None and snapshot_id != str(expected_snapshot_id):
            raise IcebergWriterError("ICEBERG_SNAPSHOT_ID_MISMATCH")
        return IcebergCommitEvidence(
            created_table=created_table,
            job_id=job_id,
            run_id=run_id,
            target=target,
            query_engine_table=target.query_engine_table(),
            snapshot_id=snapshot_id,
            committed_at=committed_at,
            warehouse_location=warehouse_location,
            schema_fingerprint=schema_fingerprint,
            rule_fingerprint=rule_fingerprint,
            source_boundary=source_boundary or {},
        )

    def ensure_namespace(self, target: IcebergWriterTarget) -> None:
        self._execute(
            "CREATE SCHEMA IF NOT EXISTS "
            + qualified_identifier(target.catalog, target.namespace)
        )

    def table_exists(self, target: IcebergWriterTarget) -> bool:
        rows = self._execute(
            "SELECT table_name FROM "
            f"{quote_identifier(target.catalog)}.information_schema.tables "
            f"WHERE table_schema = {sql_literal(target.namespace)} "
            f"AND table_name = {sql_literal(target.table)} LIMIT 1"
        )
        return bool(rows)

    def describe_table(self, target: IcebergWriterTarget) -> list[list[Any]]:
        rows = self._execute(f"DESCRIBE {qualified_target(target)}")
        if not rows:
            raise IcebergWriterError("ICEBERG_TABLE_VERIFICATION_EMPTY_SCHEMA")
        return rows

    def latest_snapshot(self, target: IcebergWriterTarget) -> tuple[str, str, str]:
        """Return the newest historical snapshot, including snapshots abandoned by rollback."""
        snapshots_table = qualified_identifier(
            target.catalog,
            target.namespace,
            f"{target.table}$snapshots",
        )
        rows = self._execute(
            "SELECT CAST(snapshot_id AS VARCHAR), CAST(committed_at AS VARCHAR), manifest_list "
            f"FROM {snapshots_table} ORDER BY committed_at DESC, snapshot_id DESC LIMIT 1"
        )
        return self._snapshot_evidence(rows)

    def current_snapshot(self, target: IcebergWriterTarget) -> tuple[str, str, str]:
        refs_table = qualified_identifier(
            target.catalog,
            target.namespace,
            f"{target.table}$refs",
        )
        rows = self._execute(
            "SELECT CAST(snapshot_id AS VARCHAR) "
            f"FROM {refs_table} WHERE name = 'main' LIMIT 1"
        )
        if not rows or not rows[0] or not str(rows[0][0] or "").strip():
            raise IcebergWriterError("ICEBERG_CURRENT_SNAPSHOT_EVIDENCE_MISSING")
        return self.snapshot(target, str(rows[0][0]).strip())

    def snapshot(self, target: IcebergWriterTarget, snapshot_id: str) -> tuple[str, str, str]:
        snapshots_table = qualified_identifier(
            target.catalog,
            target.namespace,
            f"{target.table}$snapshots",
        )
        rows = self._execute(
            "SELECT CAST(snapshot_id AS VARCHAR), CAST(committed_at AS VARCHAR), manifest_list "
            f"FROM {snapshots_table} "
            f"WHERE CAST(snapshot_id AS VARCHAR) = {sql_literal(snapshot_id)} LIMIT 1"
        )
        return self._snapshot_evidence(rows)

    @staticmethod
    def _snapshot_evidence(rows: list[list[Any]]) -> tuple[str, str, str]:
        if not rows or len(rows[0]) < 3:
            raise IcebergWriterError("ICEBERG_SNAPSHOT_EVIDENCE_MISSING")
        snapshot_id = str(rows[0][0] or "").strip()
        committed_at = str(rows[0][1] or "").strip()
        warehouse_location = warehouse_location_from_manifest(rows[0][2])
        if not snapshot_id or not committed_at or not warehouse_location:
            raise IcebergWriterError("ICEBERG_SNAPSHOT_EVIDENCE_INCOMPLETE")
        return snapshot_id, committed_at, warehouse_location

    def table_storage_metrics(
        self,
        target: IcebergWriterTarget,
        *,
        snapshot_id: str | None = None,
    ) -> tuple[int, int]:
        if snapshot_id is not None:
            snapshots_table = qualified_identifier(
                target.catalog,
                target.namespace,
                f"{target.table}$snapshots",
            )
            snapshot_literal = snapshot_version_literal(snapshot_id)
            rows = self._execute(
                "SELECT TRY_CAST(element_at(summary, 'total-data-files') AS BIGINT), "
                "TRY_CAST(element_at(summary, 'total-files-size') AS BIGINT) "
                f"FROM {snapshots_table} WHERE snapshot_id = {snapshot_literal} LIMIT 1"
            )
            return self._storage_metrics(rows)
        files_table = qualified_identifier(
            target.catalog,
            target.namespace,
            f"{target.table}$files",
        )
        rows = self._execute(
            "SELECT COUNT(*), COALESCE(SUM(file_size_in_bytes), 0) "
            f"FROM {files_table}"
        )
        return self._storage_metrics(rows)

    def verify_snapshot_run_row_count(
        self,
        target: IcebergWriterTarget,
        *,
        snapshot_id: str,
        run_id: str,
        expected_row_count: int,
    ) -> int:
        """Bind an external writer run to its exact verified Iceberg snapshot."""
        if isinstance(expected_row_count, bool) or not isinstance(expected_row_count, int):
            raise IcebergWriterError("ICEBERG_RUN_ROW_COUNT_EXPECTATION_INVALID")
        if expected_row_count < 0:
            raise IcebergWriterError("ICEBERG_RUN_ROW_COUNT_EXPECTATION_INVALID")
        normalized_run_id = str(run_id or "")
        if not normalized_run_id:
            raise IcebergWriterError("ICEBERG_RUN_ID_INVALID")
        snapshot_literal = snapshot_version_literal(snapshot_id)
        rows = self._execute(
            f"SELECT COUNT(*) FROM {qualified_target(target)} "
            f"FOR VERSION AS OF {snapshot_literal} "
            f"WHERE {quote_identifier('_asklake_run_id')} = {sql_literal(normalized_run_id)}"
        )
        if not rows or not rows[0] or rows[0][0] is None:
            raise IcebergWriterError("ICEBERG_RUN_ROW_COUNT_EVIDENCE_MISSING")
        try:
            actual_row_count = int(rows[0][0])
        except (TypeError, ValueError, OverflowError) as exc:
            raise IcebergWriterError("ICEBERG_RUN_ROW_COUNT_EVIDENCE_INVALID") from exc
        if actual_row_count < 0:
            raise IcebergWriterError("ICEBERG_RUN_ROW_COUNT_EVIDENCE_INVALID")
        if actual_row_count != expected_row_count:
            raise IcebergWriterError(
                "ICEBERG_RUN_ROW_COUNT_MISMATCH",
                f"Expected {expected_row_count} rows for run {normalized_run_id}, found {actual_row_count}",
            )
        return actual_row_count

    @staticmethod
    def _storage_metrics(rows: list[list[Any]]) -> tuple[int, int]:
        if not rows or len(rows[0]) < 2:
            raise IcebergWriterError("ICEBERG_FILE_EVIDENCE_MISSING")
        if rows[0][0] is None or rows[0][1] is None:
            raise IcebergWriterError("ICEBERG_FILE_EVIDENCE_INCOMPLETE")
        file_count = int(rows[0][0] or 0)
        storage_size_bytes = int(rows[0][1] or 0)
        if file_count < 0 or storage_size_bytes < 0:
            raise IcebergWriterError("ICEBERG_FILE_EVIDENCE_INVALID")
        return file_count, storage_size_bytes

    def drop_table(self, target: IcebergWriterTarget) -> None:
        self._execute(f"DROP TABLE IF EXISTS {qualified_target(target)}")

    def query_rows(self, query: str) -> list[list[Any]]:
        return self._execute(trusted_select_sql(query))

    def _commit_statement(
        self,
        target: IcebergWriterTarget,
        select_sql: str,
        *,
        existed_before: bool,
    ) -> str:
        destination = qualified_target(target)
        if target.write_mode == "append" and existed_before:
            return f"INSERT INTO {destination} {select_sql}"
        replace = " OR REPLACE" if target.write_mode == "replace" and existed_before else ""
        properties = ["format = 'PARQUET'"]
        if target.partition_columns:
            partitioning = ", ".join(sql_literal(column) for column in target.partition_columns)
            properties.append(f"partitioning = ARRAY[{partitioning}]")
        return f"CREATE{replace} TABLE {destination} WITH ({', '.join(properties)}) AS {select_sql}"

    def _execute(self, query: str) -> list[list[Any]]:
        page = self.client.submit(query)
        rows = list(page.rows)
        pages = 0
        while page.next_uri and page.error is None:
            if pages >= self.settings.trino_max_result_pages:
                raise IcebergWriterError("ICEBERG_TRINO_PAGE_LIMIT")
            page = self.client.fetch(page.next_uri)
            rows.extend(page.rows)
            pages += 1
        require_successful_page(page)
        return rows


def require_successful_page(page: TrinoClientPage) -> None:
    if page.error is None:
        return
    raise IcebergWriterError(
        str(page.error.code or "ICEBERG_TRINO_QUERY_FAILED"),
        str(page.error.message or "Iceberg writer query failed"),
    )


def trusted_select_sql(value: str) -> str:
    query = str(value or "").strip().rstrip(";").strip()
    try:
        statements = parse(query, read="trino")
    except ParseError as exc:
        raise IcebergWriterError("ICEBERG_SELECT_QUERY_REQUIRED") from exc
    if len(statements) != 1 or not isinstance(statements[0], (exp.Query, exp.Values)):
        raise IcebergWriterError("ICEBERG_SELECT_QUERY_REQUIRED")
    return query


def qualified_target(target: IcebergWriterTarget) -> str:
    return qualified_identifier(target.catalog, target.namespace, target.table)


def qualified_identifier(*parts: str) -> str:
    return ".".join(quote_identifier(part) for part in parts)


def quote_identifier(value: str) -> str:
    return f'"{str(value).replace(chr(34), chr(34) * 2)}"'


def sql_literal(value: str) -> str:
    return f"'{str(value).replace(chr(39), chr(39) * 2)}'"


def snapshot_version_literal(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or not normalized.lstrip("-").isdigit():
        raise IcebergWriterError("ICEBERG_SNAPSHOT_ID_INVALID")
    return str(int(normalized))


def warehouse_location_from_manifest(value: object) -> str:
    manifest_list = str(value or "").strip()
    marker = "/metadata/"
    if marker not in manifest_list:
        return ""
    return manifest_list.split(marker, 1)[0].rstrip("/")
