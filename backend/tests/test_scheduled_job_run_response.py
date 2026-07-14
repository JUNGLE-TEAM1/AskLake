import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.schemas.etl import JobCommandResponse
from app.services.etl_service import run_due_scheduled_jobs


class ScheduledJobRunResponseTest(unittest.TestCase):
    def test_due_response_contains_advanced_next_run(self) -> None:
        job = SimpleNamespace(
            id="job-1",
            name="Daily job",
            status="scheduled",
            schedule="매일 09:00",
            schedule_policy={"nextRunUtc": "2020-01-01T00:00:00Z"},
        )
        refreshed = SimpleNamespace(next_run="2026-07-15T00:00:00Z")
        with (
            patch("app.services.etl_service.etl_repository.list_job_models", return_value=[job]),
            patch("app.services.etl_service.command_job", return_value=JobCommandResponse(
                action="etl.run.requested",
                api_path="/api/etl/jobs/job-1/commands",
            )),
            patch("app.services.etl_service.advance_scheduled_job_after_tick"),
            patch("app.services.etl_service.etl_repository.get_job_schema", return_value=refreshed),
            patch("app.services.etl_service.with_job_permissions", return_value=refreshed),
        ):
            response = run_due_scheduled_jobs(
                object(),
                SimpleNamespace(force=False, job_id=None, kafka_only=False),
            )

        self.assertEqual(response.triggered_count, 1)
        self.assertEqual(response.items[0].response.job.next_run, "2026-07-15T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
