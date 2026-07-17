from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from app.schemas.catalog import CatalogDatasetResponse, CatalogDatasetRowsResponse
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    quote_clickhouse_identifier,
)
from app.services.iceberg_dataset_reader import (
    execute_trino_rows,
    iceberg_dataset_table,
    iceberg_dataset_target,
    iceberg_dataset_user_columns,
    iceberg_read_reason,
    qualified_iceberg_table,
    quote_trino_identifier,
)
from app.services.sql_service import (
    RemotePreviewBudget,
    format_sql_cell,
    quote_duckdb_identifier,
    register_duckdb_storage_location,
    remote_preview_max_bytes,
    sql_storage_error,
)
from app.services.trino_client import TrinoClient


def read_dataset_rows(
    dataset: CatalogDatasetResponse,
    *,
    limit: int,
    offset: int,
    trino_client: TrinoClient | None = None,
    clickhouse_client: ClickHouseClient | None = None,
) -> CatalogDatasetRowsResponse:
    """Read one bounded page from the dataset's current materialization."""

    if str(dataset.storage_format or "").strip().casefold() == "clickhouse":
        return read_clickhouse_dataset_rows(
            dataset,
            limit=limit,
            offset=offset,
            client=clickhouse_client,
        )

    try:
        iceberg_table = iceberg_dataset_table(dataset)
    except (TypeError, ValueError) as error:
        raise sql_storage_error(
            "Catalog Iceberg dataset mapping is unavailable",
            {"datasetId": dataset.id, "reason": str(error)[:500]},
        ) from error
    if iceberg_table is not None:
        return read_iceberg_dataset_rows(
            dataset,
            iceberg_table,
            limit=limit,
            offset=offset,
            client=trino_client or TrinoClient(),
        )

    connection = duckdb.connect(database=":memory:")
    try:
        with TemporaryDirectory(prefix="asklake-catalog-rows-") as remote_cache_dir:
            registered = register_duckdb_storage_location(
                connection,
                dataset,
                dataset.name,
                remote_cache_root=Path(remote_cache_dir),
                remote_budget=RemotePreviewBudget(remote_preview_max_bytes()),
            )
            if not registered:
                raise sql_storage_error(
                    "Catalog dataset materialization is unavailable",
                    {
                        "datasetId": dataset.id,
                        "storageLocation": dataset.storage_location,
                    },
                )
            table_name = quote_duckdb_identifier(dataset.name)
            row_count = int(
                connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
            )
            cursor = connection.execute(
                f"SELECT * FROM {table_name} LIMIT ? OFFSET ?",
                [limit, offset],
            )
            columns = [str(description[0]) for description in (cursor.description or [])]
            rows = [
                [format_sql_cell(cell) for cell in row]
                for row in cursor.fetchall()
            ]
    except duckdb.Error as error:
        raise sql_storage_error(
            "Catalog dataset rows could not be read",
            {"datasetId": dataset.id, "message": str(error)},
        ) from error
    finally:
        connection.close()

    return CatalogDatasetRowsResponse(
        columns=columns,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        has_next=offset + len(rows) < row_count,
        limit=limit,
        offset=offset,
        returned_rows=len(rows),
        row_count=row_count,
        rows=rows,
    )


def read_clickhouse_dataset_rows(
    dataset: CatalogDatasetResponse,
    *,
    limit: int,
    offset: int,
    client: ClickHouseClient | None = None,
) -> CatalogDatasetRowsResponse:
    target = dataset.clickhouse_table
    if target is None:
        raise sql_storage_error(
            "Catalog ClickHouse dataset mapping is unavailable",
            {"datasetId": dataset.id},
        )
    table = qualified_clickhouse_table(target.database, target.table)
    columns = [
        str(item[0])
        for item in dataset.schema_
        if isinstance(item, (list, tuple)) and item and str(item[0]).strip()
    ]
    if not columns:
        raise sql_storage_error(
            "Catalog ClickHouse dataset schema is unavailable",
            {"datasetId": dataset.id},
        )
    resolved_client = client or ClickHouseClient()
    owns_client = client is None
    projection = ", ".join(quote_clickhouse_identifier(item) for item in columns)
    try:
        count_result = resolved_client.query(f"SELECT count() AS row_count FROM {table} FINAL")
        row_count = int(count_result.rows[0][0]) if count_result.rows else 0
        page = resolved_client.query(
            f"SELECT {projection} FROM {table} FINAL LIMIT {int(limit)} OFFSET {int(offset)}"
        )
    except (ClickHouseError, RuntimeError, TypeError, ValueError) as error:
        raise sql_storage_error(
            "Catalog ClickHouse dataset rows could not be read",
            {"datasetId": dataset.id, "reason": str(error)[:500]},
        ) from error
    finally:
        if owns_client:
            resolved_client.close()
    rows = [[format_sql_cell(cell) for cell in row] for row in page.rows]
    return CatalogDatasetRowsResponse(
        columns=columns,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        has_next=offset + len(rows) < row_count,
        limit=limit,
        offset=offset,
        returned_rows=len(rows),
        row_count=row_count,
        rows=rows,
    )


def read_iceberg_dataset_rows(
    dataset: CatalogDatasetResponse,
    iceberg_table: str,
    *,
    limit: int,
    offset: int,
    client: TrinoClient,
) -> CatalogDatasetRowsResponse:
    try:
        target = iceberg_dataset_target(dataset)
        if target is None:
            raise ValueError("Iceberg dataset target is unavailable")
        columns = iceberg_dataset_user_columns(dataset)
        if not columns:
            raise ValueError("Catalog Iceberg dataset schema has no user columns")
        refs_table = qualified_iceberg_table(target, suffix="$refs")
        snapshot_result = execute_trino_rows(
            client,
            "SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id "
            f"FROM {refs_table} WHERE name = 'main' LIMIT 1",
        )
        if not snapshot_result.rows or not snapshot_result.rows[0]:
            raise ValueError("Trino did not return the current Iceberg snapshot")
        snapshot_id = iceberg_snapshot_version(snapshot_result.rows[0][0])
        versioned_table = f"{iceberg_table} FOR VERSION AS OF {snapshot_id}"
        projection = ", ".join(quote_trino_identifier(column) for column in columns)
        count_result = execute_trino_rows(
            client,
            f"SELECT COUNT(*) AS row_count FROM {versioned_table}",
        )
        if not count_result.rows or not count_result.rows[0]:
            raise ValueError("Trino did not return the Iceberg dataset row count")
        row_count = int(count_result.rows[0][0] or 0)
        page_result = execute_trino_rows(
            client,
            f"SELECT {projection} FROM {versioned_table} OFFSET {offset} LIMIT {limit}",
        )
    except (ApiError, RuntimeError, TypeError, ValueError) as error:
        raise sql_storage_error(
            "Catalog Iceberg dataset rows could not be read",
            {"datasetId": dataset.id, "reason": iceberg_read_reason(error)},
        ) from error

    rows = [[format_sql_cell(cell) for cell in row] for row in page_result.rows]
    return CatalogDatasetRowsResponse(
        columns=columns,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        has_next=offset + len(rows) < row_count,
        limit=limit,
        offset=offset,
        returned_rows=len(rows),
        row_count=row_count,
        rows=rows,
    )


def iceberg_snapshot_version(value: object) -> str:
    normalized = str(value or "").strip()
    if not normalized or not normalized.lstrip("-").isdigit():
        raise ValueError("Trino returned an invalid Iceberg snapshot ID")
    return str(int(normalized))
