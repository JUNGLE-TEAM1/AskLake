import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import duckdb
from fastapi.testclient import TestClient

from app.api.catalog import get_catalog_service
from app.core.auth_context import ActorContext, get_actor_context
from app.core.errors import ApiError
from app.main import create_app
from app.schemas.common import ErrorCode
from app.schemas.catalog import (
    CatalogDatasetResponse,
    CatalogDatasetRowsResponse,
    DatasetMaterializationRun,
)
from app.schemas.trino import TrinoClientPage
from app.services.catalog_service import (
    CatalogService,
    dataset_for_latest_successful_materialization,
)
from app.services.dataset_rows_service import read_dataset_rows


class FakeCatalogRowsTrinoClient:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def submit(self, query: str, **_kwargs) -> TrinoClientPage:
        self.queries.append(query)
        if "$refs" in query:
            return TrinoClientPage(columns=["snapshot_id"], rows=[[101]], queryId="refs")
        if "COUNT(*)" in query:
            return TrinoClientPage(columns=["row_count"], rows=[[3]], queryId="count")
        return TrinoClientPage(
            columns=["id", "label"],
            rows=[[2, "row-2"]],
            queryId="page",
        )

    def fetch(self, _next_uri: str, **_kwargs) -> TrinoClientPage:
        raise AssertionError("fixture query should fit in one Trino page")


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
        actor = ActorContext()
        service = CatalogService(
            lake_storage=None,
            repository=SimpleNamespace(db=object()),  # type: ignore[arg-type]
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
            patch("app.services.catalog_service.require_governed_access"),
            patch("app.services.catalog_service.require_permission"),
        ):
            actual = service.get_dataset_rows(
                self.dataset.id,
                actor,
                limit=25,
                offset=50,
            )

        self.assertIs(actual, expected)
        get_dataset.assert_called_once_with(self.dataset.id, actor)
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

    def test_iceberg_dataset_rows_use_the_verified_trino_mapping(self) -> None:
        dataset = self.dataset.model_copy(update={
            "query_engine_status": "available",
            "query_engine_table": {
                "catalog": "iceberg",
                "schema": "asklake",
                "table": "catalog_rows_fixture",
                "format": "iceberg",
            },
            "storage_format": "iceberg",
            "storage_location": "s3://warehouse/asklake/catalog_rows_fixture",
        })
        client = FakeCatalogRowsTrinoClient()

        page = read_dataset_rows(
            dataset,
            limit=1,
            offset=2,
            trino_client=client,  # type: ignore[arg-type]
        )

        self.assertEqual(page.row_count, 3)
        self.assertEqual(page.rows, [["2", "row-2"]])
        self.assertFalse(page.has_next)
        self.assertEqual(
            client.queries,
            [
                'SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id FROM "iceberg"."asklake"."catalog_rows_fixture$refs" WHERE name = \'main\' LIMIT 1',
                'SELECT COUNT(*) AS row_count FROM "iceberg"."asklake"."catalog_rows_fixture" FOR VERSION AS OF 101',
                'SELECT "id", "label" FROM "iceberg"."asklake"."catalog_rows_fixture" FOR VERSION AS OF 101 OFFSET 2 LIMIT 1',
            ],
        )
        self.assertTrue(all("_asklake_" not in query for query in client.queries))

    def test_iceberg_trino_api_error_is_wrapped_without_masking_the_cause(self) -> None:
        sensitive_message = (
            "Trino at https://private-query.example.internal failed; "
            "token=do-not-expose; query=SELECT * FROM private_table"
        )
        dataset = self.dataset.model_copy(update={
            "query_engine_status": "available",
            "query_engine_table": {
                "catalog": "iceberg",
                "schema": "asklake",
                "table": "catalog_rows_fixture",
                "format": "iceberg",
            },
            "storage_format": "iceberg",
            "storage_location": "s3://warehouse/asklake/catalog_rows_fixture",
        })
        client = SimpleNamespace(
            submit=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                ApiError(ErrorCode.BACKEND_TIMEOUT, sensitive_message, 503)
            )
        )

        with self.assertRaises(ApiError) as raised:
            read_dataset_rows(
                dataset,
                limit=1,
                offset=0,
                trino_client=client,  # type: ignore[arg-type]
            )

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(
            raised.exception.message,
            "Catalog Iceberg dataset rows could not be read",
        )
        self.assertEqual(
            raised.exception.details,
            {"datasetId": dataset.id, "reason": "BACKEND_TIMEOUT"},
        )
        self.assertNotIn(sensitive_message, raised.exception.message)
        self.assertNotIn(sensitive_message, str(raised.exception.details))
        self.assertIsInstance(raised.exception.__cause__, ApiError)
        self.assertEqual(raised.exception.__cause__.code, ErrorCode.BACKEND_TIMEOUT)

    def test_rows_endpoint_returns_sanitized_http_502_envelope(self) -> None:
        sensitive_message = (
            "Trino at https://private-query.example.internal failed; "
            "token=do-not-expose; query=SELECT * FROM private_table"
        )

        dataset = self.dataset.model_copy(update={
            "query_engine_status": "available",
            "query_engine_table": {
                "catalog": "iceberg",
                "schema": "asklake",
                "table": "catalog_rows_fixture",
                "format": "iceberg",
            },
            "storage_format": "iceberg",
            "storage_location": "s3://warehouse/asklake/catalog_rows_fixture",
        })
        client = SimpleNamespace(
            submit=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                ApiError("TRINO_UNAVAILABLE", sensitive_message, 503)
            )
        )

        class FailingCatalogService:
            def get_dataset_rows(self, dataset_id, _actor, *, limit, offset):
                self_dataset = dataset.model_copy(update={"id": dataset_id})
                return read_dataset_rows(
                    self_dataset,
                    limit=limit,
                    offset=offset,
                    trino_client=client,  # type: ignore[arg-type]
                )

        app = create_app()
        app.dependency_overrides[get_catalog_service] = FailingCatalogService
        app.dependency_overrides[get_actor_context] = lambda: ActorContext(
            name="catalog-reader",
            role="viewer",
        )

        response = TestClient(app).get(
            "/api/catalog/datasets/catalog_rows_fixture/rows?limit=1&offset=0"
        )

        self.assertEqual(response.status_code, 502)
        error = response.json()["error"]
        self.assertEqual(
            {
                "code": error["code"],
                "details": error["details"],
                "message": error["message"],
            },
            {
                "code": "SQL_STORAGE_ERROR",
                "details": {
                    "datasetId": "catalog_rows_fixture",
                    "reason": "TRINO_UNAVAILABLE",
                },
                "message": "Catalog Iceberg dataset rows could not be read",
            },
        )
        self.assertEqual(error["stage"], "api")
        self.assertTrue(error["retryable"])
        self.assertEqual(
            error["operatorMessage"],
            "Catalog Iceberg dataset rows could not be read",
        )
        self.assertEqual(
            error["userMessage"],
            "Catalog Iceberg dataset rows could not be read",
        )
        self.assertTrue(error["diagnosticId"])
        self.assertNotIn(sensitive_message, response.text)
        self.assertNotIn("private-query.example.internal", response.text)
        self.assertNotIn("do-not-expose", response.text)


if __name__ == "__main__":
    unittest.main()
