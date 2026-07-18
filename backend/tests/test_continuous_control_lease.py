from __future__ import annotations

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.etl import ContinuousControlLeaseModel
from app.repositories import continuous_control_lease_repository as leases


class ContinuousControlLeaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        ContinuousControlLeaseModel.__table__.create(self.engine)
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_only_one_worker_owns_a_live_control_plane_lease(self) -> None:
        with patch("app.repositories.etl_repository.ensure_schema") as ensure_schema:
            first = leases.acquire_or_renew(
                self.db,
                control_plane="continuous-runtime-sync",
                owner_id="worker-a",
                lease_seconds=30,
            )
            second = leases.acquire_or_renew(
                self.db,
                control_plane="continuous-runtime-sync",
                owner_id="worker-b",
                lease_seconds=30,
            )
            renewed = leases.acquire_or_renew(
                self.db,
                control_plane="continuous-runtime-sync",
                owner_id="worker-a",
                lease_seconds=30,
            )

        self.assertEqual(first, 1)
        self.assertIsNone(second)
        self.assertEqual(renewed, 1)
        ensure_schema.assert_not_called()

    def test_expired_lease_is_taken_over_with_a_new_generation(self) -> None:
        with patch("app.repositories.continuous_control_lease_repository.datetime") as mocked_datetime:
            mocked_datetime.now.return_value = self._time("2026-07-18T00:00:00+00:00")
            first = leases.acquire_or_renew(
                self.db,
                control_plane="continuous-runtime-sync",
                owner_id="worker-a",
                lease_seconds=1,
            )
            mocked_datetime.now.return_value = self._time("2026-07-18T00:00:02+00:00")
            second = leases.acquire_or_renew(
                self.db,
                control_plane="continuous-runtime-sync",
                owner_id="worker-b",
                lease_seconds=30,
            )

        self.assertEqual(first, 1)
        self.assertEqual(second, 2)

    @staticmethod
    def _time(value: str):
        from datetime import datetime

        return datetime.fromisoformat(value)
