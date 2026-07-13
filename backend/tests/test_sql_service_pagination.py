from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.sql import QueryRunRequest
from app.services import sql_service


def run_payload(row_count: int) -> dict[str, object]:
    """Build a legacy JSON-backed run to keep old saved runs readable."""
    rows = [[str(index)] for index in range(1, row_count + 1)]
    return {
        "baseDatasetId": "ds_orders",
        "columns": ["id"],
        "datasetId": "ds_orders",
        "datasetName": "orders",
        "executedAt": "2026-07-13T00:00:00.000Z",
        "mode": "preview",
        "previewLimit": 100,
        "query": 'SELECT id FROM "orders" ORDER BY id',
        "referenceDatasetIds": [],
        "resultRows": rows,
        "rowCount": row_count,
        "rows": rows[:100],
        "runId": "sql_pagination_fixture",
    }


class FakeSqlRepository:
    def __init__(self) -> None:
        self.db = object()
        self.payload: dict[str, object] | None = None

    def get_run_payload(self, _: str) -> dict[str, object] | None:
        return self.payload

    def save_run_payload(self, payload: dict[str, object]) -> dict[str, object]:
        self.payload = payload
        return payload


class SqlServicePaginationTest(TestCase):
    def test_empty_result_has_zero_range(self) -> None:
        response = sql_service.query_run_response_from_payload(
            run_payload(0),
            limit=100,
            offset=0,
        )

        self.assertEqual(response.row_count, 0)
        self.assertEqual(response.returned_rows, 0)
        self.assertEqual((response.range_start, response.range_end), (0, 0))
        self.assertFalse(response.has_next)
        self.assertEqual(response.rows, [])

    def test_exactly_one_page_has_no_next_page(self) -> None:
        response = sql_service.query_run_response_from_payload(
            run_payload(100),
            limit=100,
            offset=0,
        )

        self.assertEqual(response.row_count, 100)
        self.assertEqual(response.returned_rows, 100)
        self.assertEqual((response.range_start, response.range_end), (1, 100))
        self.assertFalse(response.has_next)

    def test_101_rows_exposes_second_page(self) -> None:
        first_page = sql_service.query_run_response_from_payload(
            run_payload(101),
            limit=100,
            offset=0,
        )
        last_page = sql_service.query_run_response_from_payload(
            run_payload(101),
            limit=100,
            offset=100,
        )

        self.assertTrue(first_page.has_next)
        self.assertEqual(last_page.row_count, 101)
        self.assertEqual(last_page.rows, [["101"]])
        self.assertEqual(last_page.returned_rows, 1)
        self.assertEqual((last_page.range_start, last_page.range_end), (101, 101))
        self.assertFalse(last_page.has_next)

    def test_legacy_10000_rows_last_page_is_accessible(self) -> None:
        response = sql_service.query_run_response_from_payload(
            run_payload(10_000),
            limit=100,
            offset=9_900,
        )

        self.assertEqual(response.row_count, 10_000)
        self.assertEqual(response.rows[0], ["9901"])
        self.assertEqual(response.rows[-1], ["10000"])
        self.assertEqual((response.range_start, response.range_end), (9_901, 10_000))
        self.assertFalse(response.has_next)

    def test_legacy_payload_is_not_clamped_at_10000_rows(self) -> None:
        response = sql_service.query_run_response_from_payload(
            run_payload(20_001),
            limit=100,
            offset=19_900,
        )

        self.assertEqual(response.row_count, 20_001)
        self.assertEqual(response.rows[0], ["19901"])
        self.assertEqual(response.rows[-1], ["20000"])
        self.assertTrue(response.has_next)

    def test_full_response_falls_back_to_visible_rows_for_pre_pagination_payload(self) -> None:
        payload = run_payload(3)
        payload.pop("resultRows")
        response = sql_service.full_query_run_response_from_payload(payload)

        self.assertEqual(response.row_count, 3)
        self.assertEqual(response.returned_rows, 3)
        self.assertEqual(response.rows, [["1"], ["2"], ["3"]])

    def test_full_query_is_stored_in_parquet_and_pageable_beyond_10000_rows(self) -> None:
        with TemporaryDirectory() as directory:
            result_path = Path(directory) / "sql_unbounded.parquet"
            result = sql_service.execute_duckdb_query_to_artifact(
                "SELECT range + 1 AS id FROM range(20001)",
                context_datasets=[],
                page_limit=100,
                result_path=result_path,
            )
            payload = {
                "columns": result["columns"],
                "datasetId": "ds_orders",
                "datasetName": "orders",
                "executedAt": "2026-07-13T00:00:00Z",
                "query": "SELECT range + 1 AS id FROM range(20001)",
                "resultStorageFormat": "parquet",
                "resultStorageLocation": str(result_path),
                "rowCount": result["row_count"],
                "rows": result["rows"],
                "runId": "sql_unbounded",
            }

            last_page = sql_service.query_run_response_from_payload(
                payload,
                limit=100,
                offset=20_000,
            )
            full_result = sql_service.full_query_run_response_from_payload(payload)

        self.assertEqual(result["row_count"], 20_001)
        self.assertEqual(len(result["rows"]), 100)
        self.assertEqual(result["rows"][0], ["1"])
        self.assertEqual(last_page.rows, [["20001"]])
        self.assertEqual((last_page.range_start, last_page.range_end), (20_001, 20_001))
        self.assertFalse(last_page.has_next)
        self.assertEqual(full_result.row_count, 20_001)
        self.assertEqual(full_result.rows[-1], ["20001"])

    def test_create_run_stores_artifact_metadata_and_returns_first_page(self) -> None:
        repository = FakeSqlRepository()
        service = sql_service.SqlService(repository=repository, catalog_repository=SimpleNamespace(db=object()))
        dataset = SimpleNamespace(
            id="ds_orders",
            name="orders",
            owner="admin",
            permission_grants=[],
            sample_rows=[],
            schema_=[("id", "integer")],
            storage_format="",
            storage_location="",
        )
        request = QueryRunRequest(
            dataset_id=dataset.id,
            limit=100,
            query="SELECT unnest(generate_series(1, 20001)) AS id",
        )

        with (
            TemporaryDirectory() as directory,
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch.object(sql_service, "register_duckdb_dataset"),
            patch.object(sql_service, "require_governed_access"),
            patch.object(sql_service, "default_storage_root", return_value=Path(directory)),
        ):
            created = service.create_query_run(request, ActorContext(name="admin", role="admin"))
            last_page = service.get_query_run(
                created.run_id,
                actor=ActorContext(name="admin", role="admin"),
                limit=100,
                offset=20_000,
            )
            self.assertIsNotNone(repository.payload)
            assert repository.payload is not None
            self.assertNotIn("resultRows", repository.payload)
            self.assertEqual(repository.payload["resultStorageFormat"], "parquet")
            self.assertTrue(Path(str(repository.payload["resultStorageLocation"])).is_file())

        self.assertEqual(created.row_count, 20_001)
        self.assertEqual(created.returned_rows, 100)
        self.assertEqual(len(created.rows), 100)
        self.assertEqual(last_page.rows, [["20001"]])
        self.assertFalse(last_page.has_next)

    def test_hydrated_run_rechecks_query_permission(self) -> None:
        repository = FakeSqlRepository()
        repository.payload = run_payload(1)
        service = sql_service.SqlService(repository=repository, catalog_repository=SimpleNamespace(db=object()))
        dataset = SimpleNamespace(
            id="ds_orders",
            name="orders",
            owner="another-user",
            permission_grants=[],
        )

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch.object(sql_service, "require_governed_access"),
            patch.object(sql_service, "safe_record_audit_event"),
            self.assertRaises(ApiError) as raised,
        ):
            service.get_query_run(
                "sql_pagination_fixture",
                actor=ActorContext(name="viewer", role="viewer"),
            )

        self.assertEqual(raised.exception.code, "FORBIDDEN")

    def test_mutating_query_remains_blocked(self) -> None:
        with self.assertRaises(ApiError) as raised:
            sql_service.validate_read_only_query("DELETE FROM orders")

        self.assertEqual(raised.exception.code, "FORBIDDEN")
