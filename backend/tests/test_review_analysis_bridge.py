from __future__ import annotations

import unittest

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
        service = ReviewAnalysisService(bridge)

        self.assertEqual(service.suggest_schema({"sample": "review"}), {"status": "ok"})
        self.assertEqual(service.run({"datasetId": "reviews"}), {"status": "ok"})
        self.assertEqual([call[0] for call in bridge.calls], [
            "reviewAnalysis.suggestSchema",
            "reviewAnalysis.run",
        ])
        self.assertTrue(all(call[2]["timeout_seconds"] >= 1 for call in bridge.calls))


if __name__ == "__main__":
    unittest.main()
