from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services.review_analysis_service import ReviewAnalysisService


class FakeVersionedBridge:
    def __init__(self) -> None:
        self.calls = []

    def execute_operation(self, operation, payload, **options):
        self.calls.append((operation, payload, options))
        return {"status": "ok"}


class ReviewAnalysisBridgeTests(unittest.TestCase):
    def test_review_analysis_uses_allow_listed_bridge_operations(self) -> None:
        bridge = FakeVersionedBridge()
        service = ReviewAnalysisService(bridge=bridge)

        with patch(
            "app.services.review_analysis_service.AiGatewayClient.suggest_review_schema",
            return_value={"status": "ok"},
        ) as suggest_schema:
            self.assertEqual(service.suggest_schema({"sample": "review"}), {"status": "ok"})
        self.assertEqual(service.run({"datasetId": "reviews"}), {"status": "ok"})
        suggest_schema.assert_called_once()
        self.assertEqual([call[0] for call in bridge.calls], ["reviewAnalysis.run"])
        self.assertTrue(all(call[2]["timeout_seconds"] >= 1 for call in bridge.calls))


if __name__ == "__main__":
    unittest.main()
