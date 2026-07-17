from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_job_list_repository, etl_repository


class EtlRepositoryJobListTests(unittest.TestCase):
    def test_list_prefetches_related_rows_once_before_projecting_jobs(self) -> None:
        jobs = [
            SimpleNamespace(id="snapshot-job", execution_mode="snapshot"),
            SimpleNamespace(id="continuous-job", execution_mode="continuous"),
        ]
        runtime = SimpleNamespace(job_id="continuous-job")
        first_run = SimpleNamespace(run_id="run-one")
        second_run = SimpleNamespace(run_id="run-two")
        db = MagicMock()
        db.scalars.return_value.all.return_value = jobs

        with (
            patch.object(etl_repository, "ensure_schema"),
            patch.object(
                etl_job_list_repository,
                "list_continuous_runtimes",
                return_value={"continuous-job": runtime},
            ) as list_runtimes,
            patch.object(
                etl_job_list_repository,
                "list_latest_run_models",
                return_value={
                    "snapshot-job": [first_run],
                    "continuous-job": [second_run],
                },
            ) as list_runs,
            patch.object(
                etl_repository,
                "job_to_schema",
                side_effect=lambda _db, job, **_kwargs: job.id,
            ) as project_job,
            patch.object(etl_repository, "run_to_schema", side_effect=lambda run: run),
        ):
            result = etl_repository.list_jobs(db)

        self.assertEqual(result, ["snapshot-job", "continuous-job"])
        self.assertEqual(db.scalars.call_count, 1)
        list_runtimes.assert_called_once_with(db, ["continuous-job"])
        list_runs.assert_called_once_with(db, ["snapshot-job", "continuous-job"])
        self.assertEqual(project_job.call_count, 2)
        self.assertTrue(all(call.kwargs["related_loaded"] for call in project_job.call_args_list))
        self.assertIsNone(project_job.call_args_list[0].kwargs["continuous_runtime"])
        self.assertIs(project_job.call_args_list[1].kwargs["continuous_runtime"], runtime)

    def test_latest_run_models_for_multiple_jobs_use_one_select(self) -> None:
        rows = [
            SimpleNamespace(job_id="job-one", run_id="run-one"),
            SimpleNamespace(job_id="job-one", run_id="run-two"),
            SimpleNamespace(job_id="job-two", run_id="run-three"),
        ]
        db = MagicMock()
        db.scalars.return_value.all.return_value = rows

        result = etl_job_list_repository.list_latest_run_models(
            db,
            ["job-one", "job-two"],
        )

        self.assertEqual(db.scalars.call_count, 1)
        self.assertEqual(result, {
            "job-one": rows[:2],
            "job-two": rows[2:],
        })

    def test_latest_run_query_returns_only_one_run_per_job(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        ETLJobModel.metadata.create_all(
            bind=engine,
            tables=[ETLJobModel.__table__, ETLRunModel.__table__],
        )
        now = datetime.now(UTC)
        with Session(engine) as db:
            db.add_all([
                _run_model("job-one", "job-one-old", now - timedelta(minutes=2)),
                _run_model("job-one", "job-one-latest", now),
                _run_model("job-two", "job-two-latest", now - timedelta(minutes=1)),
            ])
            db.commit()

            grouped = etl_job_list_repository.list_latest_run_models(
                db,
                ["job-one", "job-two"],
            )

        engine.dispose()
        self.assertEqual(
            {job_id: [run.run_id for run in runs] for job_id, runs in grouped.items()},
            {
                "job-one": ["job-one-latest"],
                "job-two": ["job-two-latest"],
            },
        )

    def test_continuous_runtimes_for_multiple_jobs_use_one_select(self) -> None:
        rows = [
            SimpleNamespace(job_id="job-one"),
            SimpleNamespace(job_id="job-two"),
        ]
        db = MagicMock()
        db.scalars.return_value.all.return_value = rows

        result = etl_job_list_repository.list_continuous_runtimes(
            db,
            ["job-one", "job-two"],
        )

        self.assertEqual(db.scalars.call_count, 1)
        self.assertEqual(result, {
            "job-one": rows[0],
            "job-two": rows[1],
        })
def _run_model(job_id: str, run_id: str, created_at: datetime) -> ETLRunModel:
    return ETLRunModel(
        created_at=created_at,
        duration="1초",
        ended_at=created_at.isoformat(),
        error_summary="",
        failed_stage="",
        input_rows="1",
        job_id=job_id,
        output_rows="1",
        run_id=run_id,
        started_at=created_at.isoformat(),
        status="success",
        updated_at=created_at,
    )


if __name__ == "__main__":
    unittest.main()
