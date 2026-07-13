from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from app.schemas.catalog import CatalogDatasetResponse, CatalogDatasetRowsResponse
from app.services.sql_service import (
    RemotePreviewBudget,
    format_sql_cell,
    quote_duckdb_identifier,
    register_duckdb_sample_rows,
    register_duckdb_storage_location,
    remote_preview_max_bytes,
    sql_storage_error,
)


def read_dataset_rows(
    dataset: CatalogDatasetResponse,
    *,
    limit: int,
    offset: int,
) -> CatalogDatasetRowsResponse:
    """Read one bounded page from the dataset's current materialization."""

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
                if dataset.storage_location:
                    raise sql_storage_error(
                        "Catalog dataset materialization is unavailable",
                        {
                            "datasetId": dataset.id,
                            "storageLocation": dataset.storage_location,
                        },
                    )
                register_duckdb_sample_rows(connection, dataset, dataset.name)
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
