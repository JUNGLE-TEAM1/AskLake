from __future__ import annotations

import hashlib
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.base import Base
from app.models.continuous_sql import (
    ContinuousSqlBatchModel,
    ContinuousSqlCommandModel,
    ContinuousSqlJobModel,
    ContinuousSqlRunModel,
)
from app.schemas.continuous_sql import (
    ContinuousSqlBatch,
    ContinuousSqlJob,
    ContinuousSqlRelationBinding,
    ContinuousSqlRun,
    continuous_sql_serving_mode,
    continuous_sql_target,
)


CONTINUOUS_SQL_TABLES = [
    ContinuousSqlJobModel.__table__,
    ContinuousSqlRunModel.__table__,
    ContinuousSqlBatchModel.__table__,
    ContinuousSqlCommandModel.__table__,
]
_schema_ready_bind_ids: set[int] = set()


def ensure_continuous_sql_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return
    Base.metadata.create_all(bind=bind, tables=CONTINUOUS_SQL_TABLES)
    _schema_ready_bind_ids.add(bind_key)


class ContinuousSqlRepository:
    def __init__(self, db: Session) -> None:
        self.db = db
        ensure_continuous_sql_schema(db)

    def add_job(self, job: ContinuousSqlJobModel) -> ContinuousSqlJobModel:
        self.db.add(job)
        self.db.flush()
        return job

    def get_job(self, job_id: str) -> ContinuousSqlJobModel | None:
        return self.db.get(ContinuousSqlJobModel, job_id)

    def lock_job(self, job_id: str) -> ContinuousSqlJobModel | None:
        return self.db.scalars(
            select(ContinuousSqlJobModel)
            .where(ContinuousSqlJobModel.id == job_id)
            .with_for_update()
        ).first()

    def job_by_output_dataset(self, dataset_id: str) -> ContinuousSqlJobModel | None:
        return self.db.scalars(
            select(ContinuousSqlJobModel).where(
                ContinuousSqlJobModel.output_dataset_id == dataset_id
            )
        ).first()

    def job_by_client_request(
        self,
        owner: str,
        client_request_id: str,
    ) -> ContinuousSqlJobModel | None:
        return self.db.scalars(
            select(ContinuousSqlJobModel).where(
                ContinuousSqlJobModel.owner == owner,
                ContinuousSqlJobModel.client_request_id == client_request_id,
            )
        ).first()

    def list_jobs(self, *, owner: str | None = None) -> list[ContinuousSqlJobModel]:
        statement = select(ContinuousSqlJobModel)
        if owner is not None:
            statement = statement.where(ContinuousSqlJobModel.owner == owner)
        return list(self.db.scalars(
            statement.order_by(
                ContinuousSqlJobModel.updated_at.desc(),
                ContinuousSqlJobModel.id.asc(),
            )
        ).all())

    def list_active_jobs(self) -> list[ContinuousSqlJobModel]:
        return list(self.db.scalars(
            select(ContinuousSqlJobModel)
            .where(
                ContinuousSqlJobModel.desired_state.in_(["running", "paused"])
                | ContinuousSqlJobModel.observed_state.in_([
                    "starting", "running", "pausing", "stopping", "recovering",
                ])
            )
            .order_by(ContinuousSqlJobModel.updated_at.asc())
        ).all())

    def add_run(self, run: ContinuousSqlRunModel) -> ContinuousSqlRunModel:
        self.db.add(run)
        self.db.flush()
        return run

    def get_run(self, run_id: str) -> ContinuousSqlRunModel | None:
        return self.db.get(ContinuousSqlRunModel, run_id)

    def latest_run(self, job_id: str) -> ContinuousSqlRunModel | None:
        return self.db.scalars(
            select(ContinuousSqlRunModel)
            .where(ContinuousSqlRunModel.job_id == job_id)
            .order_by(
                ContinuousSqlRunModel.generation.desc(),
                ContinuousSqlRunModel.created_at.desc(),
            )
            .limit(1)
        ).first()

    def add_command(self, command: ContinuousSqlCommandModel) -> ContinuousSqlCommandModel:
        self.db.add(command)
        self.db.flush()
        return command

    def get_command(self, job_id: str, command_id: str) -> ContinuousSqlCommandModel | None:
        return self.db.scalars(
            select(ContinuousSqlCommandModel).where(
                ContinuousSqlCommandModel.job_id == job_id,
                ContinuousSqlCommandModel.command_id == command_id,
            )
        ).first()

    def get_batch(
        self,
        job_id: str,
        generation: int,
        batch_id: int,
    ) -> ContinuousSqlBatchModel | None:
        return self.db.scalars(
            select(ContinuousSqlBatchModel).where(
                ContinuousSqlBatchModel.job_id == job_id,
                ContinuousSqlBatchModel.generation == generation,
                ContinuousSqlBatchModel.batch_id == batch_id,
            )
        ).first()

    def batch_by_output_commit_id(
        self,
        job_id: str,
        generation: int,
        output_commit_id: str,
    ) -> ContinuousSqlBatchModel | None:
        return self.db.scalars(
            select(ContinuousSqlBatchModel).where(
                ContinuousSqlBatchModel.job_id == job_id,
                ContinuousSqlBatchModel.generation == generation,
                ContinuousSqlBatchModel.output_commit_id == output_commit_id,
            )
        ).first()

    def next_batch_id(self, job_id: str, generation: int) -> int:
        latest = self.db.scalars(
            select(ContinuousSqlBatchModel.batch_id)
            .where(
                ContinuousSqlBatchModel.job_id == job_id,
                ContinuousSqlBatchModel.generation == generation,
            )
            .order_by(ContinuousSqlBatchModel.batch_id.desc())
            .limit(1)
        ).first()
        return int(latest if latest is not None else -1) + 1

    def stage_batch(self, batch: ContinuousSqlBatchModel) -> tuple[ContinuousSqlBatchModel, bool]:
        existing = self.get_batch(batch.job_id, batch.generation, batch.batch_id)
        if existing is None:
            self.db.add(batch)
            self.db.flush()
            return batch, True
        immutable_mismatch = any((
            existing.run_id != batch.run_id,
            existing.plan_hash != batch.plan_hash,
            list(existing.input_offsets or []) != list(batch.input_offsets or []),
            list(existing.static_snapshots or []) != list(batch.static_snapshots or []),
            dict(existing.source_boundary or {}) != dict(batch.source_boundary or {}),
            bool(existing.output_commit_id and batch.output_commit_id and existing.output_commit_id != batch.output_commit_id),
            bool(existing.manifest_path and batch.manifest_path and existing.manifest_path != batch.manifest_path),
            bool(
                existing.output_commit is not None
                and batch.output_commit is not None
                and output_commit_identity(existing.output_commit) != output_commit_identity(batch.output_commit)
            ),
            int(existing.row_count or 0) != int(batch.row_count or 0),
        ))
        if immutable_mismatch:
            raise ValueError("Continuous SQL batch identity was reused with different lineage evidence")
        if batch.output_commit is not None:
            existing.output_commit = batch.output_commit
        existing.output_commit_id = batch.output_commit_id or existing.output_commit_id
        existing.manifest_path = batch.manifest_path or existing.manifest_path
        existing.row_count = int(batch.row_count or 0)
        existing.published_at = batch.published_at or existing.published_at
        existing.last_error_code = batch.last_error_code
        existing.last_error_message = batch.last_error_message
        self.db.add(existing)
        self.db.flush()
        return existing, False

    def list_batches(self, job_id: str, *, limit: int = 100) -> list[ContinuousSqlBatchModel]:
        return list(self.db.scalars(
            select(ContinuousSqlBatchModel)
            .where(ContinuousSqlBatchModel.job_id == job_id)
            .order_by(
                ContinuousSqlBatchModel.generation.desc(),
                ContinuousSqlBatchModel.batch_id.desc(),
            )
            .limit(max(1, min(int(limit), 500)))
        ).all())


def job_to_schema(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel | None = None,
) -> ContinuousSqlJob:
    return ContinuousSqlJob(
        id=job.id,
        name=job.name,
        owner=job.owner,
        created_by=job.created_by,
        original_sql=job.original_sql,
        normalized_sql=job.normalized_sql,
        plan_version=job.plan_version,
        plan_hash=job.plan_hash,
        compiled_plan=dict(job.compiled_plan or {}),
        relation_bindings=[
            ContinuousSqlRelationBinding.model_validate(item)
            for item in job.relation_bindings or []
        ],
        static_binding_policy=job.static_binding_policy,
        trigger_interval_seconds=int(job.trigger_interval_seconds),
        serving_mode=continuous_sql_serving_mode(job),
        checkpoint_path=job.checkpoint_path,
        output_dataset_id=job.output_dataset_id,
        output_dataset_name=job.output_dataset_name,
        output_layer=job.output_layer,
        output_storage_path=job.output_storage_path,
        output_target=continuous_sql_target(job.output_target),
        desired_state=job.desired_state,
        observed_state=job.observed_state,
        generation=int(job.generation),
        active_run_id=job.active_run_id,
        worker_id=job.worker_id,
        last_error_code=job.last_error_code,
        last_error_message=job.last_error_message,
        active_run=run_to_schema(run) if run is not None else None,
    )


def run_to_schema(run: ContinuousSqlRunModel | None) -> ContinuousSqlRun | None:
    if run is None:
        return None
    return ContinuousSqlRun(
        run_id=run.run_id,
        job_id=run.job_id,
        generation=int(run.generation),
        fencing_token_hash=hashlib.sha256(run.fencing_token.encode("utf-8")).hexdigest(),
        plan_hash=run.plan_hash,
        status=run.status,
        static_bindings=list(run.static_bindings or []),
        checkpoint_path=run.checkpoint_path,
        worker_id=run.worker_id,
        started_at=run.started_at,
        ended_at=run.ended_at,
        last_error_code=run.last_error_code,
        last_error_message=run.last_error_message,
    )


def batch_to_schema(batch: ContinuousSqlBatchModel) -> ContinuousSqlBatch:
    return ContinuousSqlBatch(
        batch_id=int(batch.batch_id),
        job_id=batch.job_id,
        run_id=batch.run_id,
        generation=int(batch.generation),
        stage=batch.stage,
        plan_hash=batch.plan_hash,
        input_offsets=list(batch.input_offsets or []),
        static_snapshots=list(batch.static_snapshots or []),
        source_boundary=dict(batch.source_boundary or {}),
        output_commit=dict(batch.output_commit) if batch.output_commit else None,
        output_commit_id=batch.output_commit_id,
        manifest_path=batch.manifest_path,
        row_count=int(batch.row_count or 0),
        dataset_revision=batch.dataset_revision,
        published_at=batch.published_at,
        last_error_code=batch.last_error_code,
        last_error_message=batch.last_error_message,
    )


def jobs_to_schema(
    jobs: Iterable[ContinuousSqlJobModel],
    repository: ContinuousSqlRepository,
) -> list[ContinuousSqlJob]:
    return [
        job_to_schema(job, repository.get_run(job.active_run_id) if job.active_run_id else None)
        for job in jobs
    ]


def output_commit_identity(value: dict) -> tuple[str, dict]:
    return (
        str(value.get("snapshotId") or value.get("snapshot_id") or ""),
        dict(value.get("sourceBoundary") or value.get("source_boundary") or {}),
    )
