"""Durable input pinning for Dataset-revision SQL execution trees.

This module deliberately owns no Kafka client.  Its responsibility is to
turn the mutable Catalog/Dashboard freshness pointer into an immutable input
set before a transform is submitted.  A later executor can therefore consume
the returned ``snapshotId`` values without re-reading "latest" state.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import status
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import DashboardLiveRepository


@dataclass(frozen=True)
class PinnedRevisionInput:
    dataset_id: str
    revision: int
    snapshot_id: str


class ContinuousSqlRevisionRunner:
    """Resolve a tree's Dataset inputs once and persist the selected revision.

    The current SQL tree model stores revision numbers on ``tree_run`` for
    compact operational visibility.  The matching revision-commit supplies
    the immutable Iceberg snapshot needed by the transform executor.
    """

    def __init__(self, db: Session) -> None:
        self.db = db
        self.repository = ContinuousSqlRepository(db)
        self.live = DashboardLiveRepository(db, ensure_schema=False)

    def pin_inputs(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> list[PinnedRevisionInput]:
        tree_run = self.repository.active_tree_run(job.id)
        if tree_run is None or tree_run.continuous_sql_run_id != run.run_id:
            raise ApiError(
                "CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE",
                "Dataset-revision SQL execution requires its active execution tree.",
                status.HTTP_409_CONFLICT,
                {"jobId": job.id, "runId": run.run_id},
            )

        static_by_dataset = {
            str(item.get("datasetId") or ""): str(item.get("snapshotId") or "")
            for item in run.static_bindings or []
            if isinstance(item, dict) and str(item.get("datasetId") or "")
        }
        revisions: dict[str, int] = {}
        pinned: list[PinnedRevisionInput] = []
        for dependency in self.repository.list_dependencies(job.id):
            dataset_id = dependency.input_dataset_id
            if dependency.input_type == "static":
                snapshot_id = static_by_dataset.get(dataset_id, "")
                if dependency.required and not snapshot_id:
                    raise self._pending(job.id, dataset_id, "static_snapshot_missing")
                continue

            freshness = self.live.get_freshness(dataset_id)
            revision = int(freshness.latest_revision or 0) if freshness is not None else 0
            if dependency.required and revision <= 0:
                raise self._pending(job.id, dataset_id, "revision_missing")
            if revision <= 0:
                continue
            commit = self.live.get_commit(dataset_id, revision)
            snapshot_id = str(commit.snapshot_id or "").strip() if commit is not None else ""
            if dependency.required and not snapshot_id:
                raise self._pending(job.id, dataset_id, "snapshot_missing", revision)
            if not snapshot_id:
                continue
            revisions[dataset_id] = revision
            pinned.append(PinnedRevisionInput(dataset_id, revision, snapshot_id))

        tree_run.input_dataset_revisions = revisions
        for node in self.repository.list_tree_nodes(tree_run.tree_run_id):
            if node.job_id == job.id:
                node.input_dataset_revisions = dict(revisions)
            else:
                dataset_id = next(
                    (
                        dependency.input_dataset_id
                        for dependency in self.repository.list_dependencies(job.id)
                        if dependency.child_job_id == node.job_id
                    ),
                    None,
                )
                node.input_dataset_revisions = (
                    {dataset_id: revisions[dataset_id]}
                    if dataset_id in revisions
                    else {}
                )
            self.db.add(node)
        self.db.add(tree_run)
        self.db.flush()
        return pinned

    @staticmethod
    def _pending(
        job_id: str,
        dataset_id: str,
        reason: str,
        revision: int | None = None,
    ) -> ApiError:
        return ApiError(
            "CONTINUOUS_SQL_INPUT_REVISION_PENDING",
            "A required input Dataset has not published a queryable immutable revision yet.",
            status.HTTP_409_CONFLICT,
            {
                "jobId": job_id,
                "datasetId": dataset_id,
                "reason": reason,
                **({"revision": revision} if revision is not None else {}),
            },
            stage="execution_tree",
            retryable=True,
            user_message="연결된 Dataset의 쿼리 가능한 revision을 기다리고 있습니다.",
        )
