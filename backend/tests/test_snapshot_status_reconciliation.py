from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from pydantic import ValidationError

from app.application.snapshot_reconciliation import (
    SnapshotReconciliationHooks,
    reconcile_active_airflow_runs,
)
from app.core.config import Settings
from app.repositories import snapshot_status_repository


class FakeSession:
    def __init__(self) -> None:
        self.rollback_count = 0

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    def rollback(self) -> None:
        self.rollback_count += 1


class FakeSessionFactory:
    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []

    def __call__(self) -> FakeSession:
        session = FakeSession()
        self.sessions.append(session)
        return session


class SnapshotStatusReconciliationTests(unittest.TestCase):
    def test_only_lock_owner_synchronizes_active_snapshot_jobs(self) -> None:
        factory = FakeSessionFactory()
        synchronized: list[str] = []
        released: list[FakeSession] = []
        errors: list[tuple[str, str]] = []
        jobs = {
            "snapshot-ok": SimpleNamespace(id="snapshot-ok", execution_mode="snapshot"),
            "snapshot-bad": SimpleNamespace(id="snapshot-bad", execution_mode="snapshot"),
            "continuous": SimpleNamespace(id="continuous", execution_mode="continuous"),
        }

        def sync_job(_db, job) -> None:
            if job.id == "snapshot-bad":
                raise RuntimeError("temporary Airflow failure")
            synchronized.append(job.id)

        result = reconcile_active_airflow_runs(
            factory,
            hooks=SnapshotReconciliationHooks(
                acquire_sync_owner=lambda _db: True,
                get_job=lambda _db, job_id: jobs.get(job_id),
                list_active_job_ids=lambda _db: ["snapshot-bad", "continuous", "missing", "snapshot-ok"],
                on_job_error=lambda job_id, error: errors.append((job_id, str(error))),
                release_sync_owner=lambda db: released.append(db),
                sync_job=sync_job,
            ),
        )

        self.assertEqual(result, 1)
        self.assertEqual(synchronized, ["snapshot-ok"])
        self.assertEqual(errors, [("snapshot-bad", "temporary Airflow failure")])
        self.assertEqual(len(released), 1)
        self.assertEqual(sum(session.rollback_count for session in factory.sessions), 1)

    def test_non_owner_process_skips_the_cycle(self) -> None:
        factory = FakeSessionFactory()
        list_calls: list[bool] = []
        release_calls: list[bool] = []

        result = reconcile_active_airflow_runs(
            factory,
            hooks=SnapshotReconciliationHooks(
                acquire_sync_owner=lambda _db: False,
                get_job=lambda _db, _job_id: None,
                list_active_job_ids=lambda _db: list_calls.append(True) or [],
                on_job_error=lambda _job_id, _error: None,
                release_sync_owner=lambda _db: release_calls.append(True),
                sync_job=lambda _db, _job: None,
            ),
        )

        self.assertEqual(result, 0)
        self.assertEqual(list_calls, [])
        self.assertEqual(release_calls, [])

    def test_non_postgres_runtime_needs_no_advisory_lock(self) -> None:
        db = MagicMock()
        db.get_bind.return_value.dialect.name = "sqlite"

        self.assertTrue(snapshot_status_repository.try_acquire_snapshot_airflow_sync(db))
        snapshot_status_repository.release_snapshot_airflow_sync(db)

        db.scalar.assert_not_called()
        db.execute.assert_not_called()

    def test_default_and_example_interval_is_five_seconds(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        for relative_path in ("backend/.env.example", "deploy/.env.example"):
            with self.subTest(relative_path=relative_path):
                contents = (repository_root / relative_path).read_text(encoding="utf-8")
                self.assertIn("AIRFLOW_RUN_SYNC_INTERVAL_SECONDS=5\n", contents)

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AIRFLOW_RUN_SYNC_INTERVAL_SECONDS", None)
            settings = Settings(_env_file=None)
        self.assertEqual(settings.airflow_run_sync_interval_seconds, 5.0)

    def test_interval_below_one_second_is_rejected(self) -> None:
        with patch.dict(os.environ, {"AIRFLOW_RUN_SYNC_INTERVAL_SECONDS": "0.5"}, clear=False):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None)


if __name__ == "__main__":
    unittest.main()
