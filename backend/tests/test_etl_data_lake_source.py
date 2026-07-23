import unittest
from unittest.mock import Mock, patch

from app.core.auth_context import ActorContext
from app.schemas.etl import ReviewPipelineRequest, SchemaColumnDraft
from app.services import etl_service


def review_request() -> ReviewPipelineRequest:
    return ReviewPipelineRequest(
        id="data-lake-review",
        job_name="data_lake_review_pipeline",
        owner="data-team-01",
        permission_summary="Data Platform Team",
        retry_policy_summary="3회 재시도",
        schedule_label="스케줄링 건너뛰기",
        schema_columns=[
            SchemaColumnDraft(
                included=True,
                nullable=True,
                source_name="id",
                target_name="id",
                type="Long",
            ),
        ],
        source_config=[
            ["Source Dataset", "source_dataset"],
            ["Source Dataset ID", "ds_source_dataset"],
        ],
        source_connection_status="success",
        source_label="source_dataset",
        source_type="Data Lake",
        target_dataset="derived_dataset",
        target_format="parquet",
        target_layer="SILVER",
    )


def dataset_payload(*, status: str = "available", query_status: str = "available") -> dict:
    return {
        "id": "ds_source_dataset",
        "name": "source_dataset",
        "owner": "data-team-01",
        "permissionGrants": [],
        "status": status,
        "queryEngineStatus": query_status,
        "queryEngineTable": {
            "catalog": "iceberg",
            "schema": "asklake",
            "table": "source_dataset_1234",
            "format": "iceberg",
        },
    }


class EtlDataLakeSourceTests(unittest.TestCase):
    def test_review_accepts_available_catalog_iceberg_source(self) -> None:
        db = Mock()
        actor = ActorContext(name="Admin User", role="admin")
        with (
            patch.object(etl_service.CatalogRepository, "get_dataset_payload", return_value=dataset_payload()),
            patch.object(etl_service, "permission_grants_for_resource", return_value=[]),
            patch.object(
                etl_service,
                "permissions_for_actor_with_governance",
                return_value=Mock(can_view=True),
            ),
        ):
            review = etl_service.review_pipeline(review_request(), db=db, actor=actor)

        self.assertTrue(review.can_create)
        self.assertTrue(any(row.label == "소스 데이터" and row.status == "ready" for row in review.validation))

    def test_review_rejects_unavailable_catalog_source(self) -> None:
        db = Mock()
        actor = ActorContext(name="Admin User", role="admin")
        with patch.object(
            etl_service.CatalogRepository,
            "get_dataset_payload",
            return_value=dataset_payload(status="processing"),
        ):
            review = etl_service.review_pipeline(review_request(), db=db, actor=actor)

        self.assertFalse(review.can_create)
        self.assertTrue(any(row.label == "소스 데이터" and row.status == "warning" for row in review.validation))

    def test_runtime_resolution_returns_iceberg_identity(self) -> None:
        db = Mock()
        with patch.object(etl_service.CatalogRepository, "get_dataset_payload", return_value=dataset_payload()):
            source = etl_service.resolve_internal_data_lake_source(
                db,
                [["Source Dataset ID", "ds_source_dataset"]],
            )

        self.assertEqual(
            source,
            {
                "catalog": "iceberg",
                "format": "iceberg",
                "namespace": "asklake",
                "table": "source_dataset_1234",
            },
        )


if __name__ == "__main__":
    unittest.main()
