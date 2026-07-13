from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

from fastapi import status
from fastapi.testclient import TestClient

from app.api.sql import get_sql_service
from app.core.auth_context import ActorContext, get_actor_context
from app.core.errors import ApiError
from app.main import create_app
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.services.sql_service import SqlService


def query_run_payload() -> dict[str, object]:
    return {
        "baseDatasetId": "base-dataset",
        "columns": ["review"],
        "datasetId": "result-dataset",
        "datasetName": "result_dataset",
        "executedAt": "2026-07-12T00:00:00Z",
        "query": "SELECT review FROM result_dataset",
        "referenceDatasetIds": [
            "reference-one",
            "base-dataset",
            "reference-two",
            "reference-one",
        ],
        "rowCount": 1,
        "rows": [["private"]],
        "runId": "sql-secret",
    }


def catalog_dataset(dataset_id: str, *, owner: str = "data-owner") -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "Restricted review output",
        "freshness": "latest",
        "id": dataset_id,
        "layer": "GOLD",
        "lastUpdated": "2026-07-12T00:00:00Z",
        "name": dataset_id.replace("-", "_"),
        "nextRefresh": "manual",
        "owner": owner,
        "quality": "validated",
        "rag": False,
        "rows": "1",
        "sampleRows": [["private"]],
        "schema": [["review", "string"]],
        "size": "1 KB",
        "source": "private",
        "status": "available",
        "tags": ["restricted"],
    })


def reject_anonymous() -> ActorContext:
    raise ApiError(
        ErrorCode.UNAUTHORIZED,
        "Authentication is required",
        status.HTTP_401_UNAUTHORIZED,
    )


class FakeSqlService:
    def __init__(self) -> None:
        self.called = False

    def get_query_run(self, _run_id: str, _actor: ActorContext) -> dict[str, object]:
        self.called = True
        return query_run_payload()


class SqlRunAuthorizationTests(unittest.TestCase):
    def test_anonymous_request_is_rejected_by_actor_dependency(self) -> None:
        service = FakeSqlService()
        app = create_app()
        app.dependency_overrides[get_sql_service] = lambda: service
        app.dependency_overrides[get_actor_context] = reject_anonymous

        response = TestClient(app).get("/api/query/runs/sql-secret")

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.json()["error"]["code"], ErrorCode.UNAUTHORIZED)
        self.assertFalse(service.called)

    def test_anonymous_sql_test_is_rejected_by_actor_dependency(self) -> None:
        app = create_app()
        app.dependency_overrides[get_actor_context] = reject_anonymous

        response = TestClient(app).post(
            "/api/sql/test",
            json={
                "sources": [
                    {"source_dataset_id": "dataset-1", "columns": ["id"]},
                ],
                "sql": "SELECT id FROM input",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.json()["error"]["code"], ErrorCode.UNAUTHORIZED)

    def test_saved_result_requires_current_dataset_query_permission(self) -> None:
        payload = query_run_payload()
        payload["baseDatasetId"] = None
        payload["referenceDatasetIds"] = []
        repository = SimpleNamespace(db=object(), get_run_payload=lambda _run_id: payload)
        catalog_repository = SimpleNamespace(db=object())
        service = SqlService(repository, catalog_repository)

        with (
            patch.object(
                service,
                "get_catalog_dataset",
                return_value=catalog_dataset("result-dataset"),
            ),
            patch("app.services.sql_service.require_governed_access") as governed_access,
            self.assertRaises(ApiError) as raised,
        ):
            service.get_query_run(
                "sql-secret",
                ActorContext(name="unauthorized", role="viewer"),
            )

        self.assertEqual(raised.exception.status_code, status.HTTP_403_FORBIDDEN)
        governed_access.assert_called_once()

    def test_unauthorized_actor_gets_403_from_saved_result_endpoint(self) -> None:
        payload = query_run_payload()
        payload["baseDatasetId"] = None
        payload["referenceDatasetIds"] = []
        service = SqlService(
            SimpleNamespace(db=object(), get_run_payload=lambda _run_id: payload),
            SimpleNamespace(db=object()),
        )
        app = create_app()
        app.dependency_overrides[get_sql_service] = lambda: service
        app.dependency_overrides[get_actor_context] = lambda: ActorContext(
            name="unauthorized",
            role="viewer",
        )

        with (
            patch.object(
                service,
                "get_catalog_dataset",
                return_value=catalog_dataset("result-dataset"),
            ),
            patch("app.services.sql_service.require_governed_access"),
        ):
            response = TestClient(app).get("/api/query/runs/sql-secret")

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.json()["error"]["code"], ErrorCode.FORBIDDEN)

    def test_saved_result_rechecks_every_dataset_context(self) -> None:
        payload = query_run_payload()
        repository = SimpleNamespace(db=object(), get_run_payload=lambda _run_id: payload)
        catalog_repository = SimpleNamespace(db=object())
        service = SqlService(repository, catalog_repository)
        actor = ActorContext(name="data-owner", role="viewer")
        expected_ids = [
            "result-dataset",
            "base-dataset",
            "reference-one",
            "reference-two",
        ]

        with (
            patch.object(
                service,
                "get_catalog_dataset",
                side_effect=lambda dataset_id: catalog_dataset(dataset_id),
            ) as get_dataset,
            patch("app.services.sql_service.require_governed_access") as governed_access,
            patch("app.services.sql_service.require_permission") as require_query,
        ):
            response = service.get_query_run("sql-secret", actor)

        self.assertEqual(response.run_id, "sql-secret")
        self.assertEqual(get_dataset.call_args_list, [call(dataset_id) for dataset_id in expected_ids])
        self.assertEqual(governed_access.call_count, len(expected_ids))
        self.assertEqual(require_query.call_count, len(expected_ids))
        for dataset_id, guard_call in zip(expected_ids, governed_access.call_args_list, strict=True):
            self.assertEqual(guard_call.args[:2], (catalog_repository.db, actor))
            self.assertEqual(guard_call.kwargs["action"], "query")
            self.assertEqual(guard_call.kwargs["api_path"], "/api/query/runs/sql-secret")
            self.assertEqual(guard_call.kwargs["http_method"], "GET")
            self.assertEqual(guard_call.kwargs["resource_id"], dataset_id)

    def test_saved_result_propagates_current_governance_denial(self) -> None:
        payload = query_run_payload()
        payload["baseDatasetId"] = None
        payload["referenceDatasetIds"] = []
        service = SqlService(
            SimpleNamespace(db=object(), get_run_payload=lambda _run_id: payload),
            SimpleNamespace(db=object()),
        )
        denied = ApiError(
            ErrorCode.FORBIDDEN,
            "Dataset is governance blocked",
            status.HTTP_403_FORBIDDEN,
        )

        with (
            patch.object(
                service,
                "get_catalog_dataset",
                return_value=catalog_dataset("result-dataset"),
            ),
            patch(
                "app.services.sql_service.require_governed_access",
                side_effect=denied,
            ),
            patch("app.services.sql_service.require_permission") as require_query,
            self.assertRaises(ApiError) as raised,
        ):
            service.get_query_run(
                "sql-secret",
                ActorContext(name="blocked", role="viewer"),
            )

        self.assertIs(raised.exception, denied)
        require_query.assert_not_called()


if __name__ == "__main__":
    unittest.main()
