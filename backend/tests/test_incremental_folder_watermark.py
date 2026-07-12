import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.etl_service import source_incremental_since


class IncrementalFolderWatermarkTests(unittest.TestCase):
    def test_uses_previous_successful_run_start_with_lookback(self) -> None:
        job = SimpleNamespace(id="job-1", schedule_policy={"watermarkPolicy": {"enabled": True, "lookbackMinutes": 5}})
        runs = [
            SimpleNamespace(run_id="previous", status="success", started_at="2026-07-11T10:00:00Z", ended_at="2026-07-11T10:05:00Z"),
            SimpleNamespace(run_id="failed", status="failed", started_at="2026-07-11T10:10:00Z", ended_at="2026-07-11T10:11:00Z"),
        ]
        with patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=runs):
            watermark = source_incremental_since(object(), job, "current")

        self.assertEqual(watermark, "2026-07-11T09:55:00Z")

    def test_file_missed_during_previous_scan_remains_inside_next_window(self) -> None:
        job = SimpleNamespace(id="job-1", schedule_policy={"watermarkPolicy": {"lookbackMinutes": 0}})
        runs = [
            SimpleNamespace(
                run_id="previous",
                status="success",
                started_at="2026-07-11T10:00:00Z",
                ended_at="2026-07-11T10:05:00Z",
            ),
        ]
        with patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=runs):
            watermark = source_incremental_since(object(), job, "current")

        missed_file_modified_at = "2026-07-11T10:03:00Z"
        self.assertEqual(watermark, "2026-07-11T10:00:00Z")
        self.assertGreater(missed_file_modified_at, watermark)

    def test_disabled_lookback_uses_previous_run_start_exactly(self) -> None:
        job = SimpleNamespace(id="job-1", schedule_policy={"watermarkPolicy": {"enabled": False, "lookbackMinutes": 30}})
        runs = [
            SimpleNamespace(
                run_id="previous",
                status="success",
                started_at="2026-07-11T10:00:00Z",
                ended_at="2026-07-11T10:05:00Z",
            ),
        ]
        with patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=runs):
            watermark = source_incremental_since(object(), job, "current")

        self.assertEqual(watermark, "2026-07-11T10:00:00Z")

    def test_first_successful_run_has_no_incremental_lower_bound(self) -> None:
        job = SimpleNamespace(id="job-1", schedule_policy={})
        with patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[]):
            watermark = source_incremental_since(object(), job, "current")

        self.assertIsNone(watermark)
