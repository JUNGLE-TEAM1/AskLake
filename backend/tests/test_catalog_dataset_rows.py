import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import duckdb

from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse, CatalogDatasetRowsResponse, DatasetMaterializationRun
from app.services.catalog_service import CatalogService, dataset_for_latest_successful_materialization
from app.services.dataset_rows_service import read_dataset_rows


def build_dataset(storage_location: str) -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "Catalog rows pagination fixture",
        "freshness": "latest",
        "id": "catalog_rows_fixture",
        "lastUpdated": "2026-07-13T00:00:00Z",
        "layer": "SILVER",
        "name": "catalog_rows_fixture",
        "nextRefresh": "manual",
        "owner": "qa",
        "quality": "100%",
        "rag": False,
        "rows": "10,000",
        "sampleRows": [],
        "schema": [["id", "BIGINT"], ["label", "VARCHAR"]],
        "size": "fixture",
        "source": "test",
        "status": "available",
        "storageFormat": "parquet",
        "storageLocation": storage_location,
        "tags": ["test"],
    })


class CatalogDatasetRowsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.parquet_path = Path(self.temporary_directory.name) / "catalog_rows.parquet"
        connection = duckdb.connect(database=":memory:")
        try:
            escaped_path = str(self.parquet_path).replace("'", "''")
            connection.execute(
                "COPY (SELECT range AS id, 'row-' || range::VARCHAR AS label "
                f"FROM range(10000)) TO '{escaped_path}' (FORMAT PARQUET)"
            )
        finally:
            connection.close()
        self.dataset = build_dataset(str(self.parquet_path))

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_reads_first_middle_and_last_page_without_loading_all_rows(self) -> None:
        first_page = read_dataset_rows(self.dataset, limit=100, offset=0)
        middle_page = read_dataset_rows(self.dataset, limit=100, offset=5000)
        last_page = read_dataset_rows(self.dataset, limit=100, offset=9900)

        self.assertEqual(first_page.row_count, 10000)
        self.assertEqual(first_page.returned_rows, 100)
        self.assertEqual(first_page.rows[0], ["0", "row-0"])
        self.assertTrue(first_page.has_next)
        self.assertEqual(middle_page.rows[0], ["5000", "row-5000"])
        self.assertEqual(last_page.rows[-1], ["9999", "row-9999"])
        self.assertFalse(last_page.has_next)

    def test_offset_at_total_returns_an_empty_page(self) -> None:
        page = read_dataset_rows(self.dataset, limit=100, offset=10000)

        self.assertEqual(page.row_count, 10000)
        self.assertEqual(page.returned_rows, 0)
        self.assertEqual(page.rows, [])
        self.assertFalse(page.has_next)

    def test_catalog_service_delegates_dataset_rows_to_bounded_reader(self) -> None:
        service = CatalogService(
            lake_storage=None,
            repository=None,
            sql_repository=None,
        )
        expected = CatalogDatasetRowsResponse(
            columns=["id", "label"],
            dataset_id=self.dataset.id,
            dataset_name=self.dataset.name,
            has_next=True,
            limit=25,
            offset=50,
            returned_rows=25,
            row_count=10000,
            rows=[["50", "row-50"]],
        )

        with (
            patch.object(service, "get_dataset", return_value=self.dataset) as get_dataset,
            patch("app.services.catalog_service.read_dataset_rows", return_value=expected) as read_rows,
        ):
            actual = service.get_dataset_rows(
                self.dataset.id,
                limit=25,
                offset=50,
            )

        self.assertIs(actual, expected)
        get_dataset.assert_called_once_with(self.dataset.id, None)
        read_rows.assert_called_once_with(self.dataset, limit=25, offset=50)

    def test_declared_but_missing_materialization_is_not_reported_as_actual_data(self) -> None:
        missing_dataset = build_dataset(
            str(Path(self.temporary_directory.name) / "missing.parquet")
        )

        with self.assertRaises(ApiError) as raised:
            read_dataset_rows(missing_dataset, limit=100, offset=0)

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")

    def test_latest_successful_materialization_wins_over_a_newer_failure(self) -> None:
        successful_run = DatasetMaterializationRun.model_validate({
            "createdAt": "2026-07-13T01:00:00Z",
            "jobId": "job-1",
            "rowCount": 10000,
            "runId": "run-success",
            "sourceLabel": "successful fixture",
            "status": "success",
            "storageLocation": str(self.parquet_path),
            "storageSizeBytes": 100,
        })
        failed_run = DatasetMaterializationRun.model_validate({
            "createdAt": "2026-07-13T02:00:00Z",
            "jobId": "job-1",
            "rowCount": 0,
            "runId": "run-failed",
            "sourceLabel": "failed fixture",
            "status": "failed",
            "storageLocation": "/tmp/failed.parquet",
            "storageSizeBytes": 0,
        })
        dataset = self.dataset.model_copy(
            update={"materialization_runs": [successful_run, failed_run]}
        )

        selected = dataset_for_latest_successful_materialization(dataset)

        self.assertEqual(selected.source_run_id, "run-success")
        self.assertEqual(selected.storage_location, str(self.parquet_path))

if __name__ == "__main__":
    unittest.main()
