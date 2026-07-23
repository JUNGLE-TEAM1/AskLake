"""Durable input pinning for Dataset-revision SQL execution trees.

This module deliberately owns no Kafka client.  Its responsibility is to
turn the mutable Catalog/Dashboard freshness pointer into an immutable input
set before a transform is submitted.  A later executor can therefore consume
the returned ``snapshotId`` values without re-reading "latest" state.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.core.config import settings
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import DashboardLiveRepository
from app.services.continuous_sql_publication import ContinuousSqlPublicationService
from app.services.iceberg_writer_service import (
    IcebergWriterError,
    IcebergWriterService,
    qualified_identifier,
    snapshot_version_literal,
    sql_literal,
)
from app.schemas.iceberg import IcebergWriterTarget


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

    def __init__(
        self,
        db: Session,
        *,
        writer: IcebergWriterService | None = None,
        publication_service: ContinuousSqlPublicationService | None = None,
    ) -> None:
        self.db = db
        self.repository = ContinuousSqlRepository(db)
        self.live = DashboardLiveRepository(db, ensure_schema=False)
        self.writer = writer or IcebergWriterService()
        self.publication_service = publication_service or ContinuousSqlPublicationService(
            db, writer=self.writer,
        )

    def start(self, job: ContinuousSqlJobModel, run: ContinuousSqlRunModel) -> dict[str, Any]:
        """Return a durable in-process runner identity without owning Kafka."""
        tree_run = self.repository.active_tree_run(job.id)
        if tree_run is None or tree_run.continuous_sql_run_id != run.run_id:
            raise ApiError(
                "CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE",
                "Dataset-revision SQL execution requires its active execution tree.",
                status.HTTP_409_CONFLICT,
                {"jobId": job.id, "runId": run.run_id},
            )
        return {
            "containerState": "running",
            "containerId": f"revision-runner:{tree_run.tree_run_id}",
        }

    def reconcile(self, job: ContinuousSqlJobModel, run: ContinuousSqlRunModel) -> bool:
        """Transform the latest fully published input set exactly once.

        Reconciliation is deliberately pull-driven by the existing Continuous
        SQL sync loop.  It does not create a Kafka consumer or polling loop;
        producer Jobs remain the only Kafka owners.
        """
        pinned = self.pin_inputs(job, run)
        tree_run = self.repository.active_tree_run(job.id)
        if tree_run is None:
            raise ApiError("CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE", "Execution tree disappeared.", status.HTTP_409_CONFLICT)
        input_snapshots = self._input_snapshots(job, run, pinned)
        realtime_dataset_ids = {
            dependency.input_dataset_id
            for dependency in self.repository.list_dependencies(job.id)
            if dependency.input_type == "realtime"
        }
        source_revision = max(
            (
                item.revision
                for item in pinned
                if item.dataset_id in realtime_dataset_ids
            ),
            default=0,
        )
        if source_revision <= 0:
            return False
        if self._already_applied(job, run, input_snapshots):
            self.repository.complete_revision_refresh(job.id, source_revision)
            return False

        claimed = self.repository.claim_revision_refresh(
            job.id,
            source_revision=source_revision,
            stale_after_seconds=settings.continuous_sql_refresh_claim_seconds,
        )
        if not claimed:
            return False

        try:
            batch_id = self.repository.next_batch_id(job.id, run.generation)
            publication_run_id = f"{run.run_id}:revision:{batch_id}"
            source_boundary = {
                "kind": "continuous_sql_batch",
                "jobId": job.id,
                "batchId": batch_id,
                "runGeneration": int(run.generation),
                "planHash": job.plan_hash,
                "fencingTokenHash": hashlib.sha256(run.fencing_token.encode("utf-8")).hexdigest(),
                "runId": publication_run_id,
                "sourceRanges": [],
                "staticSnapshots": list(run.static_bindings or []),
                "inputDatasetRevisions": dict(tree_run.input_dataset_revisions or {}),
                "inputSnapshots": input_snapshots,
            }
            select_sql = self._transform_select(job, input_snapshots, publication_run_id)
            row_count = int(self.writer.query_rows(
                f"SELECT COUNT(*) FROM ({select_sql}) AS \"__asklake_count\""
            )[0][0])
            refresh_target = IcebergWriterTarget.model_validate(job.output_target).model_copy(
                update={"write_mode": "replace"}
            )
            evidence = self.writer.commit_select(
                refresh_target,
                select_sql,
                job_id=job.id,
                run_id=publication_run_id,
                schema_fingerprint=str(job.compiled_plan.get("schemaFingerprint") or "") or None,
                rule_fingerprint=job.plan_hash,
                source_boundary=source_boundary,
            )
            publication = {
                "batchId": batch_id,
                "continuousSqlRunGeneration": int(run.generation),
                "continuousSqlPlanHash": job.plan_hash,
                "continuousSqlFencingTokenHash": source_boundary["fencingTokenHash"],
                "storedCount": row_count,
                "sourceRanges": [],
                "staticSnapshots": list(run.static_bindings or []),
                "sourceBoundary": source_boundary,
                "runId": publication_run_id,
                "manifestPath": (
                    f"{job.output_storage_path.rstrip('/')}/_revision-transforms/"
                    f"{run.run_id}/{batch_id}.json"
                ),
                "icebergCommit": evidence.model_dump(mode="json", by_alias=True),
                "publishedAt": datetime.now(UTC).isoformat(),
            }
            batch = self.publication_service.reconcile_manifest(job, run, publication)
            if batch.stage != "dashboard_ready":
                raise ApiError(
                    batch.last_error_code or "CONTINUOUS_SQL_PUBLICATION_PENDING",
                    batch.last_error_message or "Dataset revision publication is pending.",
                    status.HTTP_409_CONFLICT,
                    {"jobId": job.id, "batchId": batch_id},
                )
            self.repository.complete_revision_refresh(job.id, source_revision)
            return True
        except IcebergWriterError as exc:
            self.repository.fail_revision_refresh(job.id, source_revision, str(exc))
            raise ApiError(
                f"CONTINUOUS_SQL_REVISION_TRANSFORM_{exc.code}",
                str(exc), status.HTTP_502_BAD_GATEWAY,
                {"jobId": job.id, "runId": run.run_id},
            ) from exc
        except Exception as exc:
            self.repository.fail_revision_refresh(job.id, source_revision, str(exc))
            raise

    def _input_snapshots(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        pinned: list[PinnedRevisionInput],
    ) -> list[dict[str, Any]]:
        by_dataset = {item.dataset_id: item for item in pinned}
        static = {
            str(item.get("datasetId") or ""): str(item.get("snapshotId") or "")
            for item in run.static_bindings or [] if isinstance(item, dict)
        }
        result: list[dict[str, Any]] = []
        for dependency in self.repository.list_dependencies(job.id):
            if dependency.input_type == "static":
                result.append({"datasetId": dependency.input_dataset_id, "snapshotId": static[dependency.input_dataset_id]})
                continue
            item = by_dataset[dependency.input_dataset_id]
            result.append({"datasetId": item.dataset_id, "revision": item.revision, "snapshotId": item.snapshot_id})
        return result

    def _already_applied(
        self, job: ContinuousSqlJobModel, run: ContinuousSqlRunModel, input_snapshots: list[dict[str, Any]],
    ) -> bool:
        for batch in self.repository.list_batches(job.id, limit=1):
            if batch.generation != run.generation or batch.stage != "dashboard_ready":
                continue
            boundary = dict(batch.source_boundary or {})
            return list(boundary.get("inputSnapshots") or []) == input_snapshots
        return False

    def _transform_select(
        self,
        job: ContinuousSqlJobModel,
        input_snapshots: list[dict[str, Any]],
        publication_run_id: str,
    ) -> str:
        snapshots = {str(item["datasetId"]): str(item["snapshotId"]) for item in input_snapshots}
        ctes: list[str] = []
        for index, relation in enumerate(job.compiled_plan.get("relations") or []):
            if not isinstance(relation, dict):
                continue
            dataset_id = str(relation.get("datasetId") or "")
            mapping = relation.get("queryEngineTable") or {}
            if not dataset_id or not isinstance(mapping, dict) or dataset_id not in snapshots:
                raise ApiError("CONTINUOUS_SQL_INPUT_REVISION_PENDING", "A relation snapshot is unavailable.", status.HTTP_409_CONFLICT, {"datasetId": dataset_id})
            ctes.append(
                f'"__asklake_relation_{index}" AS (SELECT * FROM '
                f'{qualified_identifier(str(mapping.get("catalog") or "iceberg"), str(mapping.get("schema") or ""), str(mapping.get("table") or ""))} '
                f'FOR VERSION AS OF {snapshot_version_literal(snapshots[dataset_id])})'
            )
        runtime_sql = str(job.compiled_plan.get("runtimeSql") or "").strip().rstrip(";")
        if not ctes or not runtime_sql:
            raise ApiError("CONTINUOUS_SQL_REVISION_PLAN_INVALID", "Revision transform plan is incomplete.", status.HTTP_409_CONFLICT, {"jobId": job.id})
        return (
            f"WITH {', '.join(ctes)} SELECT \"__asklake_result\".*, "
            f"{sql_literal(publication_run_id)} AS \"_asklake_run_id\", "
            "CURRENT_TIMESTAMP AS \"_asklake_ingested_at\" "
            f"FROM ({runtime_sql}) AS \"__asklake_result\""
        )

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
