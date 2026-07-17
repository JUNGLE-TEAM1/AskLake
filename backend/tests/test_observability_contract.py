from __future__ import annotations

from types import SimpleNamespace
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.errors import ApiError, api_error_handler, unhandled_error_handler
from app.core.observability import (
    CORRELATION_ID_HEADER,
    CorrelationIdMiddleware,
    bind_correlation_id,
    metrics_snapshot,
    redact,
    reset_correlation_id,
    reset_metrics_for_test,
)
from app.infrastructure.runtime_io import VersionedNodeBridge


def test_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(CorrelationIdMiddleware)
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    @app.get("/ok")
    def ok() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/known-error")
    def known_error() -> None:
        raise ApiError(
            "OBSERVABILITY_TEST",
            "safe message",
            503,
            {"password": "do-not-return", "reason": "safe"},
            stage="execution",
            retryable=True,
        )

    @app.get("/unhandled")
    def unhandled() -> None:
        raise RuntimeError("secret=do-not-return")

    return app


class ObservabilityContractTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_metrics_for_test()

    def test_valid_correlation_id_round_trips_and_is_counted(self) -> None:
        response = TestClient(test_app()).get("/ok", headers={CORRELATION_ID_HEADER: "demo-request-42"})
        self.assertEqual(response.headers[CORRELATION_ID_HEADER], "demo-request-42")
        self.assertIn("http_requests_completed_total{method=GET,status_family=2xx}", metrics_snapshot())

    def test_invalid_correlation_id_is_replaced(self) -> None:
        response = TestClient(test_app()).get("/ok", headers={CORRELATION_ID_HEADER: "invalid value with spaces"})
        self.assertNotEqual(response.headers[CORRELATION_ID_HEADER], "invalid value with spaces")
        self.assertRegex(response.headers[CORRELATION_ID_HEADER], r"^[a-f0-9]{32}$")

    def test_error_envelope_is_redacted_and_diagnostic_is_copyable(self) -> None:
        response = TestClient(test_app()).get("/known-error", headers={CORRELATION_ID_HEADER: "diag-123"})
        payload = response.json()["error"]
        self.assertEqual(payload["diagnosticId"], "diag-123")
        self.assertEqual(payload["stage"], "execution")
        self.assertTrue(payload["retryable"])
        self.assertEqual(payload["details"]["password"], "[REDACTED]")
        self.assertNotIn("do-not-return", response.text)

    def test_unhandled_error_does_not_expose_exception_text(self) -> None:
        response = TestClient(test_app(), raise_server_exceptions=False).get("/unhandled")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("do-not-return", response.text)
        self.assertTrue(response.json()["error"]["diagnosticId"])

    def test_correlation_id_reaches_versioned_node_bridge(self) -> None:
        captured: dict[str, str] = {}

        def runner(*_args, **kwargs):
            captured["input"] = kwargs["input"]
            import json
            request = json.loads(kwargs["input"])
            return SimpleNamespace(
                returncode=0,
                stderr="",
                stdout=json.dumps({"version": "1.0", "requestId": request["requestId"], "ok": True, "result": {}}),
            )

        token = bind_correlation_id("bridge-diag-7")
        try:
            VersionedNodeBridge(backend_dir=__import__("pathlib").Path("."), runner=runner).execute_operation(
                "review_analysis",
                {},
                timeout_seconds=1,
            )
        finally:
            reset_correlation_id(token)
        self.assertIn('"requestId": "bridge-diag-7"', captured["input"])

    def test_redaction_handles_nested_secrets_and_bearer_values(self) -> None:
        value = redact({"nested": {"accessKey": "abc"}, "message": "Bearer top-secret"})
        self.assertEqual(value["nested"]["accessKey"], "[REDACTED]")
        self.assertEqual(value["message"], "Bearer [REDACTED]")


if __name__ == "__main__":
    unittest.main()
