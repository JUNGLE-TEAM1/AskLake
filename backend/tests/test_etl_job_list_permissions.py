from __future__ import annotations

import unittest
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.schemas.etl import JobRowData
from app.schemas.permissions import PermissionGrant
from app.services.etl_service import with_jobs_permissions


def _job(job_id: str, *, owner: str) -> JobRowData:
    return JobRowData(
        id=job_id,
        last_run="-",
        last_state="준비됨",
        name=f"job-{job_id}",
        next_run="-",
        owner=owner,
        schedule="수동",
        source="fixture",
        status="scheduled",
        tag="[생성]",
        target="fixture_target",
    )


class EtlJobListPermissionTests(unittest.TestCase):
    def test_permission_and_governance_state_are_loaded_once_for_the_whole_list(self) -> None:
        jobs = [
            _job("job-granted", owner="another-owner"),
            _job("job-owned", owner="reader"),
        ]
        actor = ActorContext(name="reader", role="viewer")
        persisted = {
            ("etl_job", "job-granted"): [PermissionGrant(
                actions=["view"],
                principal_id="reader",
                principal_type="user",
                source="admin",
            )],
            ("etl_job", "job-owned"): [],
        }

        with (
            patch(
                "app.services.etl_service.list_permission_grants_by_resource",
                return_value=persisted,
            ) as list_grants,
            patch(
                "app.services.etl_service.blocked_principal_for_actor",
                return_value=None,
            ) as blocked_actor,
            patch(
                "app.services.etl_service.locked_resource_ids",
                return_value={"job-owned"},
            ) as list_locks,
        ):
            projected = with_jobs_permissions(object(), jobs, actor)

        list_grants.assert_called_once()
        blocked_actor.assert_called_once()
        list_locks.assert_called_once()
        self.assertTrue(projected[0].permissions.can_view)
        self.assertTrue(projected[1].permissions.can_view)
        self.assertFalse(projected[1].permissions.can_run)


if __name__ == "__main__":
    unittest.main()
