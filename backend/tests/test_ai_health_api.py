import unittest
from unittest.mock import patch

from fastapi import Response

from app.api.health import ai_health_check


class AiHealthApiTests(unittest.TestCase):
    def test_gateway_health_returns_safe_dependency_details(self) -> None:
        response = Response()
        upstream = {
            "ok": True,
            "status": "ok",
            "service": "ai-gateway",
            "provider": "openai",
            "model": "gpt-5-mini",
            "mcp": "ready",
            "checks": {"provider": "ready", "mcp": "ready", "token": "must-not-leak"},
            "capabilities": ["dashboard_assistant"],
            "providerApiKey": "must-not-leak",
        }

        with (
            patch("app.api.health.settings.ai_query_provider", "gateway"),
            patch("app.api.health.AiGatewayClient.health_status", return_value=upstream),
        ):
            payload = ai_health_check(response)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["gateway"]["mcp"], "ready")
        self.assertNotIn("providerApiKey", payload["gateway"])
        self.assertNotIn("token", payload["gateway"]["checks"])

    def test_gateway_health_preserves_unconfigured_status(self) -> None:
        response = Response()
        with (
            patch("app.api.health.settings.ai_query_provider", "gateway"),
            patch(
                "app.api.health.AiGatewayClient.health_status",
                return_value={"ok": False, "status": "unconfigured", "capabilities": []},
            ),
        ):
            payload = ai_health_check(response)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["status"], "unconfigured")
        self.assertEqual(payload["provider"], "gateway")

    def test_direct_health_remains_disabled(self) -> None:
        response = Response()
        with patch("app.api.health.settings.ai_query_provider", "direct"):
            payload = ai_health_check(response)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload, {"ok": True, "status": "disabled", "provider": "direct"})


if __name__ == "__main__":
    unittest.main()
