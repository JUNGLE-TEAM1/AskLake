import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.main import create_app
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardCard,
)
from app.services.dashboard_assistant_service import DashboardAssistantService
from app.services.dashboard_runtime_service import DashboardRuntimeService


def dashboard_card(dashboard_id: str, principal_id: str) -> DashboardCard:
    return DashboardCard.model_validate({
        "id": dashboard_id,
        "name": dashboard_id,
        "owner": "dashboard-owner",
        "meta": "test dashboard",
        "status": "draft",
        "tags": "test",
        "updated": "now",
        "permissionGrants": [{
            "actions": ["view"],
            "principalId": principal_id,
            "principalType": "user",
        }],
    })


def assistant_dataset_payload(
    dataset_id: str,
    *,
    principal_id: str,
    sample_value: str,
) -> dict[str, object]:
    return {
        "description": "assistant dataset",
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": "2026-07-12T00:00:00Z",
        "layer": "GOLD",
        "name": dataset_id,
        "nextRefresh": "-",
        "owner": "dataset-owner",
        "permissionGrants": [{
            "actions": ["query", "view"],
            "principalId": principal_id,
            "principalType": "user",
        }],
        "quality": "passed",
        "rag": False,
        "rows": "1 row",
        "sampleRows": [[sample_value, "1"]],
        "schema": [["category", "string"], ["amount", "number"]],
        "size": "1 KiB",
        "source": "test",
        "status": "available",
        "tags": ["assistant"],
    }


class FakeAssistantCatalogRepository:
    def __init__(self, payloads: list[dict[str, object]]) -> None:
        self.db = SimpleNamespace()
        self.models = [SimpleNamespace(payload=payload) for payload in payloads]

    def list_dataset_models(self):
        return self.models


class DashboardAssistantAccessTests(unittest.TestCase):
    def test_anonymous_dependency_failure_returns_401_before_assistant_execution(self) -> None:
        app = create_app()

        def reject_anonymous_actor() -> ActorContext:
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "A valid AskLake session is required.",
                401,
            )

        app.dependency_overrides[get_actor_context] = reject_anonymous_actor
        try:
            with patch("app.api.dashboard_assistant.DashboardAssistantService.generate_response") as generate:
                response = TestClient(app).post(
                    "/api/dashboards/assistant",
                    json={"mode": "dashboard_question", "prompt": "Summarize this dashboard"},
                )
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")
        generate.assert_not_called()

    def test_route_checks_requested_dashboard_before_generating_a_response(self) -> None:
        app = create_app()
        actor = ActorContext(name="dashboard-viewer", role="viewer")
        app.dependency_overrides[get_actor_context] = lambda: actor
        app.dependency_overrides[get_db] = lambda: SimpleNamespace()
        try:
            with (
                patch(
                    "app.api.dashboard_assistant.DashboardRuntimeRepository",
                    return_value=SimpleNamespace(),
                ),
                patch(
                    "app.api.dashboard_assistant.CatalogRepository",
                    return_value=SimpleNamespace(),
                ),
                patch(
                    "app.api.dashboard_assistant.DashboardRuntimeService.require_assistant_access"
                ) as require_access,
                patch(
                    "app.api.dashboard_assistant.DashboardAssistantService.generate_response",
                    return_value=DashboardAssistantResponse(message="ok"),
                ) as generate,
            ):
                response = TestClient(app).post(
                    "/api/dashboards/assistant",
                    json={
                        "dashboardId": "dashboard-a",
                        "mode": "dashboard_question",
                        "prompt": "Summarize this dashboard",
                    },
                )
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        require_access.assert_called_once_with("dashboard-a", actor)
        generate.assert_called_once()
        self.assertIs(generate.call_args.args[1], actor)

    def test_dashboard_view_permission_is_evaluated_per_dashboard(self) -> None:
        cards = {
            "dashboard-a": dashboard_card("dashboard-a", "dashboard-viewer"),
            "dashboard-b": dashboard_card("dashboard-b", "another-viewer"),
        }
        service = DashboardRuntimeService(
            SimpleNamespace(db=SimpleNamespace()),
            SimpleNamespace(),
        )
        actor = ActorContext(name="dashboard-viewer", role="viewer")

        with (
            patch(
                "app.services.dashboard_runtime_service.get_dashboard_card",
                side_effect=lambda _db, dashboard_id: cards.get(dashboard_id),
            ),
            patch(
                "app.services.dashboard_runtime_service.dashboard_with_persisted_permission_grants",
                side_effect=lambda _db, card: card,
            ),
            patch("app.services.dashboard_runtime_service.require_governed_access"),
            patch("app.services.dashboard_runtime_service.safe_record_audit_event"),
        ):
            service.require_assistant_access("dashboard-a", actor)
            with self.assertRaises(ApiError) as denied:
                service.require_assistant_access("dashboard-b", actor)

        self.assertEqual(denied.exception.status_code, 403)

    def test_provider_context_excludes_unauthorized_and_locked_dataset_samples(self) -> None:
        actor = ActorContext(name="dashboard-viewer", role="viewer")
        catalog_repository = FakeAssistantCatalogRepository([
            assistant_dataset_payload(
                "dataset-allowed",
                principal_id="dashboard-viewer",
                sample_value="allowed-visible",
            ),
            assistant_dataset_payload(
                "dataset-denied",
                principal_id="another-viewer",
                sample_value="denied-secret",
            ),
            assistant_dataset_payload(
                "dataset-locked",
                principal_id="dashboard-viewer",
                sample_value="locked-secret",
            ),
        ])
        service = DashboardAssistantService(
            SimpleNamespace(),
            catalog_repository,
            SimpleNamespace(
                openai_api_key="test-key",
                openai_assistant_enabled=True,
                openai_assistant_max_sample_rows=5,
            ),
        )
        request = DashboardAssistantRequest.model_validate({
            "mode": "dashboard_question",
            "prompt": "Summarize the available revenue data",
            "widgets": [{
                "config": {"columns": ["category"]},
                "dataSample": [{"secret": "denied-widget-secret"}],
                "datasetId": "dataset-denied",
                "id": "denied-widget",
                "layout": {"x": 0, "y": 0, "w": 4, "h": 3},
                "title": "Denied widget",
                "type": "table",
            }],
        })
        captured_context: dict[str, object] = {}

        def fake_openai(_request, context):
            captured_context.update(context.to_prompt_payload())
            return {"actions": [], "message": "ok", "warnings": []}

        def enforce_governance(*_args, **kwargs):
            if kwargs.get("resource_id") == "dataset-locked":
                raise ApiError(ErrorCode.FORBIDDEN, "locked", 403)

        with (
            patch(
                "app.services.dashboard_assistant_context.datasets_with_persisted_permission_grants",
                side_effect=lambda _db, datasets: datasets,
            ),
            patch(
                "app.services.dashboard_dataset_access.require_governed_access",
                side_effect=enforce_governance,
            ),
            patch("app.services.dashboard_dataset_access.safe_record_audit_event"),
            patch.object(service, "_request_openai", side_effect=fake_openai),
        ):
            response = service.generate_response(request, actor)

        serialized_context = json.dumps(captured_context, ensure_ascii=False)
        self.assertEqual(response.message, "ok")
        self.assertEqual(
            [dataset["id"] for dataset in captured_context["availableDatasets"]],
            ["dataset-allowed"],
        )
        self.assertEqual(captured_context["widgets"], [])
        self.assertIn("allowed-visible", serialized_context)
        self.assertNotIn("denied-secret", serialized_context)
        self.assertNotIn("locked-secret", serialized_context)
        self.assertNotIn("denied-widget-secret", serialized_context)


if __name__ == "__main__":
    unittest.main()
