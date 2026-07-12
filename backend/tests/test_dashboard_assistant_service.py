import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    DashboardAssistantMode,
    DashboardAssistantRequest,
    DashboardRuntimeWidgetType,
)
from app.services.dashboard_assistant_context import (
    AssistantColumnContext,
    AssistantDashboardContext,
    AssistantDatasetContext,
    AssistantWidgetContext,
)
from app.services.dashboard_assistant_service import DashboardAssistantService


class DashboardAssistantServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.actor = ActorContext(name="assistant-tester", role="admin")
        self.question_request = DashboardAssistantRequest(
            mode=DashboardAssistantMode.DASHBOARD_QUESTION,
            prompt="Summarize monthly revenue.",
        )
        self.empty_context = AssistantDashboardContext(id=None)

    @staticmethod
    def build_service(*, enabled: bool = True, api_key: str | None = "test-key") -> DashboardAssistantService:
        settings = SimpleNamespace(
            openai_api_key=api_key,
            openai_assistant_enabled=enabled,
            openai_assistant_max_sample_rows=5,
            openai_assistant_max_output_tokens=1200,
            openai_assistant_model="gpt-4o-mini",
            openai_assistant_timeout_seconds=20.0,
        )
        return DashboardAssistantService(
            runtime_repository=SimpleNamespace(),
            catalog_repository=SimpleNamespace(),
            settings=settings,
        )

    def test_disabled_assistant_raises_503_without_building_context(self) -> None:
        service = self.build_service(enabled=False)

        with (
            patch("app.services.dashboard_assistant_service.build_assistant_context") as build_context,
            self.assertRaises(ApiError) as raised,
        ):
            service.generate_response(self.question_request, self.actor)

        self.assertEqual(raised.exception.code, ErrorCode.SERVICE_UNAVAILABLE)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("disabled", raised.exception.message)
        self.assertEqual(
            raised.exception.details,
            {"reason": "OPENAI_ASSISTANT_ENABLED is false"},
        )
        build_context.assert_not_called()

    def test_missing_api_key_raises_503_without_building_context(self) -> None:
        service = self.build_service(api_key=None)

        with (
            patch("app.services.dashboard_assistant_service.build_assistant_context") as build_context,
            self.assertRaises(ApiError) as raised,
        ):
            service.generate_response(self.question_request, self.actor)

        self.assertEqual(raised.exception.code, ErrorCode.SERVICE_UNAVAILABLE)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("OPENAI_API_KEY", raised.exception.message)
        self.assertEqual(
            raised.exception.details,
            {"reason": "OPENAI_API_KEY is not configured"},
        )
        build_context.assert_not_called()

    def test_openai_failures_raise_502_with_the_actual_reason(self) -> None:
        failures = [
            (
                HTTPError(
                    "https://api.openai.com/v1/responses",
                    429,
                    "Too Many Requests",
                    None,
                    None,
                ),
                "HTTP 429 Too Many Requests",
            ),
            (URLError("connection refused"), "connection refused"),
            (TimeoutError("request timed out"), "request timed out"),
            (ValueError("OpenAI response did not include output text"), "OpenAI response did not include output text"),
            (OSError("TLS handshake failed"), "TLS handshake failed"),
        ]

        for failure, expected_reason in failures:
            with self.subTest(exception_type=failure.__class__.__name__):
                service = self.build_service()
                with (
                    patch(
                        "app.services.dashboard_assistant_service.build_assistant_context",
                        return_value=self.empty_context,
                    ),
                    patch.object(service, "_request_openai", side_effect=failure),
                    self.assertRaises(ApiError) as raised,
                ):
                    service.generate_response(self.question_request, self.actor)

                self.assertEqual(raised.exception.code, ErrorCode.INTERNAL_ERROR)
                self.assertEqual(raised.exception.status_code, 502)
                self.assertIn(expected_reason, raised.exception.message)
                self.assertEqual(raised.exception.details["reason"], expected_reason)
                self.assertEqual(
                    raised.exception.details["exceptionType"],
                    failure.__class__.__name__,
                )

    def test_openai_error_payload_exposes_provider_reason_as_502(self) -> None:
        class ErrorResponse:
            def __enter__(self) -> "ErrorResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            @staticmethod
            def read() -> bytes:
                return (
                    b'{"error":{"message":"rate limit exceeded",'
                    b'"type":"rate_limit_error"}}'
                )

        service = self.build_service()
        with (
            patch(
                "app.services.dashboard_assistant_service.build_assistant_context",
                return_value=self.empty_context,
            ),
            patch(
                "app.services.dashboard_assistant_service.urlopen",
                return_value=ErrorResponse(),
            ),
            self.assertRaises(ApiError) as raised,
        ):
            service.generate_response(self.question_request, self.actor)

        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("rate limit exceeded", raised.exception.message)
        self.assertEqual(
            raised.exception.details["reason"],
            "OpenAI response contained an error: rate limit exceeded",
        )

    def test_real_openai_report_response_still_passes_through_guard(self) -> None:
        service = self.build_service()
        raw_response = {
            "message": "Revenue declined in March.",
            "actions": [
                {
                    "type": "report",
                    "markdown": "## Revenue\n\nMarch was lower than February.",
                }
            ],
            "warnings": [],
        }

        with (
            patch(
                "app.services.dashboard_assistant_service.build_assistant_context",
                return_value=AssistantDashboardContext(
                    id=None,
                    warnings=["context warning"],
                ),
            ),
            patch.object(service, "_request_openai", return_value=raw_response),
        ):
            response = service.generate_response(self.question_request, self.actor)

        self.assertEqual(response.message, "Revenue declined in March.")
        self.assertEqual(len(response.actions), 1)
        self.assertEqual(response.actions[0].type, "report")
        self.assertEqual(response.warnings, ["context warning"])

    def test_real_visualization_response_can_still_receive_safe_action_fallback(self) -> None:
        service = self.build_service()
        request = DashboardAssistantRequest(
            mode=DashboardAssistantMode.VISUALIZATION_REQUEST,
            prompt="Create a bar chart counting rows by category.",
            selected_widget_id="widget-1",
        )
        context = AssistantDashboardContext(
            id="dashboard-1",
            datasets=[
                AssistantDatasetContext(
                    id="dataset-1",
                    name="orders",
                    layer="gold",
                    description="Order facts",
                    columns=[
                        AssistantColumnContext(name="category", type="string"),
                        AssistantColumnContext(name="amount", type="double"),
                    ],
                    sample_rows=[{"category": "phones", "amount": 100.0}],
                    tags=["orders"],
                )
            ],
            widgets=[
                AssistantWidgetContext(
                    id="widget-1",
                    title="Requested chart",
                    type=DashboardRuntimeWidgetType.BAR_CHART,
                    dataset_id=None,
                    config={"placeholderKind": "visualization_request"},
                    data_sample=[],
                )
            ],
        )

        with (
            patch(
                "app.services.dashboard_assistant_service.build_assistant_context",
                return_value=context,
            ),
            patch.object(
                service,
                "_request_openai",
                return_value={"message": "Chart request received.", "actions": [], "warnings": []},
            ),
        ):
            response = service.generate_response(request, self.actor)

        self.assertEqual(len(response.actions), 1)
        self.assertEqual(response.actions[0].type, "update_widget")
        self.assertEqual(response.actions[0].widget_id, "widget-1")
        self.assertEqual(response.actions[0].patch.dataset_id, "dataset-1")


if __name__ == "__main__":
    unittest.main()
