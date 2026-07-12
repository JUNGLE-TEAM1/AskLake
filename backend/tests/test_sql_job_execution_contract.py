from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.core.errors import ApiError
from app.services.etl_service import sql_job_execution_contract


SQL_RUN_PAYLOAD = {
    "baseDatasetId": "ds_reviews",
    "columns": ["id", "product_name"],
    "datasetId": "ds_reviews",
    "datasetName": "reviews",
    "executedAt": "2026-07-12T00:00:00Z",
    "mode": "preview",
    "previewLimit": 2,
    "query": (
        "SELECT reviews.id, products.product_name "
        "FROM reviews JOIN products ON reviews.product_id = products.id "
        "WHERE reviews.score >= 4"
    ),
    "referenceDatasetIds": ["ds_products"],
    "rowCount": 2,
    "rows": [["1", "Phone"], ["2", "Case"]],
    "runId": "sql_full_materialization",
}


def dataset(dataset_id, name, materialization_runs):
    return SimpleNamespace(
        id=dataset_id,
        materialization_runs=materialization_runs,
        name=name,
        storage_format="parquet",
        storage_location=None,
    )


def source_config(query=SQL_RUN_PAYLOAD["query"]):
    return [
        ["SQL Execution Contract", "catalog_sql_v1"],
        ["Source Dataset ID", "ds_reviews"],
        ["SQL Run ID", "sql_full_materialization"],
        ["Reference Dataset IDs", "ds_products"],
        ["Preview Limit", "2"],
        ["Preview Row Count", "2"],
        ["Query", query],
    ]


class SqlJobExecutionContractTests(unittest.TestCase):
    def setUp(self):
        self.datasets = {
            "ds_reviews": dataset(
                "ds_reviews",
                "reviews",
                [
                    {"materializationMode": "delta", "runId": "run-2", "status": "success", "storageFormat": "json", "storageLocation": "s3a://lake/reviews/run-2"},
                    {"materializationMode": "snapshot", "runId": "run-1", "status": "success", "storageFormat": "parquet", "storageLocation": "s3a://lake/reviews/run-1"},
                ],
            ),
            "ds_products": dataset(
                "ds_products",
                "products",
                [
                    {"status": "success", "storageFormat": "csv", "storageLocation": "s3a://lake/products/run-1"},
                ],
            ),
        }

    def resolve(self, fields=None):
        with (
            patch(
                "app.services.etl_service.SqlRepository.get_run_payload",
                return_value=SQL_RUN_PAYLOAD,
            ),
            patch(
                "app.services.etl_service.etl_repository.get_dataset_schema_by_id",
                side_effect=lambda _db, dataset_id: self.datasets.get(dataset_id),
            ),
        ):
            return sql_job_execution_contract(object(), "SQL Result", fields or source_config())

    def test_contract_uses_saved_query_and_every_physical_materialization(self):
        contract = self.resolve()
        payload = contract.model_dump(mode="json", by_alias=True)

        self.assertEqual(payload["query"], SQL_RUN_PAYLOAD["query"])
        self.assertNotIn("previewLimit", payload)
        self.assertNotIn("rows", payload)
        self.assertEqual(payload["baseDatasetId"], "ds_reviews")
        self.assertEqual(payload["referenceDatasetIds"], ["ds_products"])
        self.assertEqual(
            payload["datasets"][0]["storageSegments"],
            [
                {"format": "parquet", "location": "s3a://lake/reviews/run-1"},
                {"format": "json", "location": "s3a://lake/reviews/run-2"},
            ],
        )
        self.assertEqual(len(payload["datasets"][1]["storageSegments"]), 1)

    def test_non_sql_job_has_no_sql_execution_contract(self):
        self.assertIsNone(sql_job_execution_contract(object(), "File / S3", []))

    def test_tampered_job_query_is_rejected_instead_of_executed(self):
        with self.assertRaises(ApiError) as raised:
            self.resolve(source_config("SELECT * FROM reviews LIMIT 2"))

        self.assertEqual(raised.exception.status_code, 409)

    def test_dataset_without_successful_physical_materialization_is_rejected(self):
        self.datasets["ds_products"] = dataset("ds_products", "products", [])

        with self.assertRaises(ApiError) as raised:
            self.resolve()

        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
