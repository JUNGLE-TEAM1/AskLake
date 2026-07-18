import unittest

from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.services.catalog_service import (
    normalized_unique_key_columns,
    unique_key_counts,
    unique_key_verification_query,
    verified_iceberg_table,
)
from app.services.iceberg_dataset_reader import TrinoRows


def dataset() -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "static users",
        "freshness": "latest",
        "id": "users",
        "lastUpdated": "2026-07-18T00:00:00Z",
        "layer": "SILVER",
        "name": "users",
        "nextRefresh": "manual",
        "owner": "data-team-01",
        "quality": "100%",
        "queryEngineStatus": "available",
        "queryEngineTable": {
            "catalog": "iceberg",
            "schema": "asklake",
            "table": "users_table",
            "format": "iceberg",
        },
        "rag": False,
        "relationMode": "static",
        "rows": "12 rows",
        "sampleRows": [],
        "schema": [["user_id", "VARCHAR"], ["region", "VARCHAR"]],
        "size": "1KB",
        "source": "fixture",
        "status": "available",
        "storageFormat": "iceberg",
        "tags": [],
    })


class CatalogUniqueKeyVerificationTest(unittest.TestCase):
    def test_builds_exact_null_empty_and_distinct_scan(self) -> None:
        current = dataset()
        columns = normalized_unique_key_columns(["USER_ID"], current)
        table = verified_iceberg_table(current)
        query = unique_key_verification_query(table, columns)

        self.assertEqual(columns, ["user_id"])
        self.assertEqual(table, '"iceberg"."asklake"."users_table"')
        self.assertIn('count_if("user_id" IS NULL OR trim(CAST("user_id" AS VARCHAR)) = \'\')', query)
        self.assertIn('count(DISTINCT "user_id")', query)

    def test_rejects_unknown_schema_column(self) -> None:
        with self.assertRaises(ApiError):
            normalized_unique_key_columns(["missing"], dataset())

    def test_reads_verification_counts(self) -> None:
        result = TrinoRows(
            columns=["total_rows", "invalid_key_rows", "distinct_keys"],
            rows=[[12, 0, 12]],
        )
        self.assertEqual(unique_key_counts(result), (12, 0, 12))


if __name__ == "__main__":
    unittest.main()
