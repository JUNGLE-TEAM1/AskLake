import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api import etl as etl_api
from app.core.auth_context import ActorContext, get_actor_context
from app.core.errors import ApiError
from app.main import create_app
from app.schemas.common import ErrorCode


def reject_missing_production_session() -> ActorContext:
    raise ApiError(
        ErrorCode.UNAUTHORIZED,
        "A valid AskLake session is required.",
        401,
    )


class EtlEndpointAuthTests(unittest.TestCase):
    def test_production_session_rejection_propagates_from_all_protected_etl_posts(self) -> None:
        app = create_app()
        app.dependency_overrides[get_actor_context] = reject_missing_production_session
        client = TestClient(app)
        requests = [
            ("/api/etl/sources/test", {"sourceType": "File / S3", "sourceConfig": []}),
            ("/api/etl/sources/assets", {"sourceType": "File / S3", "sourceConfig": [], "prefix": ""}),
            ("/api/etl/schema-inference", {"sourceType": "File / S3", "sourceConfig": []}),
            ("/api/etl/review", {}),
            ("/api/etl/kafka/reviews/ingest", {}),
            ("/api/etl/jobs", {}),
        ]

        for path, payload in requests:
            with self.subTest(path=path):
                response = client.post(path, json=payload)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_source_routes_require_manage_permission_before_service_call(self) -> None:
        actor = ActorContext(name="Read Only", role="viewer")
        source_request = object()
        for endpoint, service_name in (
            (etl_api.test_source_connector, "test_source_connector"),
            (etl_api.list_source_assets, "list_source_assets"),
            (etl_api.infer_schema, "infer_schema"),
            (etl_api.review_pipeline, "review_pipeline"),
        ):
            with self.subTest(endpoint=endpoint.__name__):
                with patch.object(etl_api.etl_service, service_name) as service:
                    with self.assertRaises(ApiError) as raised:
                        endpoint(source_request, actor)
                self.assertEqual(raised.exception.status_code, 403)
                service.assert_not_called()

    def test_kafka_ingest_uses_run_permission_and_job_create_uses_manage(self) -> None:
        actor = ActorContext(name="Admin", role="admin")
        with (
            patch.object(etl_api, "require_permission") as require_permission,
            patch.object(etl_api.etl_service, "ingest_kafka_reviews", return_value="ingested"),
        ):
            result = etl_api.ingest_kafka_reviews(object(), object(), actor)

        self.assertEqual(result, "ingested")
        require_permission.assert_called_once_with(actor, "run", resource_label="Kafka review ingest")

        request = unittest.mock.Mock()
        request.model_copy.return_value = request
        with (
            patch.object(etl_api, "require_permission") as require_permission,
            patch.object(etl_api.etl_service, "create_pipeline", return_value="created"),
        ):
            result = etl_api.create_job(request, object(), actor)

        self.assertEqual(result, "created")
        require_permission.assert_called_once_with(actor, "manage", resource_label="job collection")
        request.model_copy.assert_called_once_with(update={"created_by": actor.name})


if __name__ == "__main__":
    unittest.main()
