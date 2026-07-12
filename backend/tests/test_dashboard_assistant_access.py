from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.main import create_app
from app.schemas.common import ErrorCode
from app.schemas.dashboard import DashboardAssistantResponse, DashboardCard
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


if __name__ == "__main__":
    unittest.main()
