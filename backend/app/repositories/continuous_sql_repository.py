from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Iterable
from weakref import WeakSet

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.base import Base
from app.models.continuous_sql import (
    ContinuousSqlBatchModel,
    ContinuousSqlCommandModel,
    ContinuousSqlDependencyModel,
    ContinuousSqlIncrementalBindingModel,
    ContinuousSqlJobModel,
    ContinuousSqlRunModel,
    ContinuousSqlTreeJobLockModel,
    ContinuousSqlTreeNodeRunModel,
    ContinuousSqlTreeRunModel,
)
from app.schemas.continuous_sql import (
    ContinuousSqlBatch,
    ContinuousSqlDependencyBinding,
    ContinuousSqlJob,
    ContinuousSqlRelationBinding,
    ContinuousSqlRun,
    ContinuousSqlExecutionTree,
    ContinuousSqlTreeJobLock,
    ContinuousSqlTreeNodeRun,
    ContinuousSqlTreeRun,
    continuous_sql_serving_mode,
    continuous_sql_target,
)


CONTINUOUS_SQL_TABLES = [
    ContinuousSqlJobModel.__table__,
    ContinuousSqlDependencyModel.__table__,
    ContinuousSqlTreeRunModel.__table__,
    ContinuousSqlTreeNodeRunModel.__table__,
    ContinuousSqlTreeJobLockModel.__table__,
    ContinuousSqlRunModel.__table__,
    ContinuousSqlBatchModel.__table__,
    ContinuousSqlCommandModel.__table__,
    ContinuousSqlIncrementalBindingModel.__table__,
]
_schema_ready_binds: WeakSet = WeakSet()


def ensure_continuous_sql_schema(db: Session) -> None:
    bind = db.get_bind()
    if bind in _schema_ready_binds:
        return
    Base.metadata.create_all(bind=bind, tables=CONTINUOUS_SQL_TABLES)
    _schema_ready_binds.add(bind)


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

    def list_dependencies(self, job_id: str) -> list[ContinuousSqlDependencyModel]:
        return list(self.db.scalars(
            select(ContinuousSqlDependencyModel)
            .where(ContinuousSqlDependencyModel.sql_job_id == job_id)
            .order_by(ContinuousSqlDependencyModel.input_dataset_id.asc())
        ).all())

    def replace_dependencies(
        self,
        job_id: str,
        dependencies: Iterable[ContinuousSqlDependencyModel],
    ) -> list[ContinuousSqlDependencyModel]:
        resolved = list(dependencies)
        if any(item.sql_job_id != job_id for item in resolved):
            raise ValueError("Continuous SQL dependency belongs to a different Job")
        self.db.execute(
            delete(ContinuousSqlDependencyModel).where(
                ContinuousSqlDependencyModel.sql_job_id == job_id
            )
        )
        self.db.add_all(resolved)
        self.db.flush()
        return resolved

    def next_tree_generation(self, job_id: str) -> int:
        latest = self.db.scalars(
            select(ContinuousSqlTreeRunModel)
            .where(ContinuousSqlTreeRunModel.sql_job_id == job_id)
            .order_by(ContinuousSqlTreeRunModel.generation.desc())
            .limit(1)
        ).first()
        return int(latest.generation if latest is not None else 0) + 1

    def add_tree_run(self, tree_run: ContinuousSqlTreeRunModel) -> ContinuousSqlTreeRunModel:
        self.db.add(tree_run)
        self.db.flush()
        return tree_run

    def add_tree_nodes(
        self,
        nodes: Iterable[ContinuousSqlTreeNodeRunModel],
    ) -> list[ContinuousSqlTreeNodeRunModel]:
        resolved = list(nodes)
        self.db.add_all(resolved)
        self.db.flush()
        return resolved

    def get_tree_run(self, tree_run_id: str) -> ContinuousSqlTreeRunModel | None:
        return self.db.get(ContinuousSqlTreeRunModel, tree_run_id)

    def active_tree_run(self, sql_job_id: str) -> ContinuousSqlTreeRunModel | None:
        return self.db.scalars(
            select(ContinuousSqlTreeRunModel)
            .where(
                ContinuousSqlTreeRunModel.sql_job_id == sql_job_id,
                ContinuousSqlTreeRunModel.status.in_([
                    "locked", "starting", "running", "pausing", "paused", "stopping", "recovering",
                ]),
            )
            .order_by(ContinuousSqlTreeRunModel.generation.desc())
            .limit(1)
        ).first()

    def list_tree_nodes(self, tree_run_id: str) -> list[ContinuousSqlTreeNodeRunModel]:
        return list(self.db.scalars(
            select(ContinuousSqlTreeNodeRunModel)
            .where(ContinuousSqlTreeNodeRunModel.tree_run_id == tree_run_id)
            .order_by(ContinuousSqlTreeNodeRunModel.node_type.desc(), ContinuousSqlTreeNodeRunModel.job_id.asc())
        ).all())

    def list_tree_locks(self, tree_run_id: str) -> list[ContinuousSqlTreeJobLockModel]:
        return list(self.db.scalars(
            select(ContinuousSqlTreeJobLockModel)
            .where(ContinuousSqlTreeJobLockModel.tree_run_id == tree_run_id)
            .order_by(ContinuousSqlTreeJobLockModel.job_id.asc())
        ).all())

    def acquire_tree_job_lock(
        self,
        *,
        job_id: str,
        tree_run_id: str,
        node_run_id: str,
        owner_sql_job_id: str,
        lock_kind: str,
        fencing_token: str,
        lease_seconds: int,
    ) -> int | None:
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=lease_seconds)
        table = ContinuousSqlTreeJobLockModel.__table__
        insert = sqlite_insert if self.db.get_bind().dialect.name == "sqlite" else postgresql_insert
        statement = insert(table).values(
            job_id=job_id,
            tree_run_id=tree_run_id,
            node_run_id=node_run_id,
            owner_sql_job_id=owner_sql_job_id,
            lock_kind=lock_kind,
            generation=1,
            fencing_token=fencing_token,
            lease_expires_at=expires_at,
            active=True,
            released_at=None,
        ).on_conflict_do_update(
            index_elements=[table.c.job_id],
            set_={
                "tree_run_id": tree_run_id,
                "node_run_id": node_run_id,
                "owner_sql_job_id": owner_sql_job_id,
                "lock_kind": lock_kind,
                "generation": table.c.generation + 1,
                "fencing_token": fencing_token,
                "lease_expires_at": expires_at,
                "active": True,
                "released_at": None,
                "updated_at": now,
            },
            where=(table.c.active.is_(False) | (table.c.lease_expires_at <= now)),
        ).returning(table.c.generation)
        generation = self.db.execute(statement).scalar_one_or_none()
        return int(generation) if generation is not None else None

    def renew_tree_locks(
        self,
        tree_run: ContinuousSqlTreeRunModel,
        lease_seconds: int,
    ) -> bool:
        expires_at = datetime.now(UTC) + timedelta(seconds=lease_seconds)
        expected = len(self.list_tree_nodes(tree_run.tree_run_id))
        result = self.db.execute(
            update(ContinuousSqlTreeJobLockModel)
            .where(
                ContinuousSqlTreeJobLockModel.tree_run_id == tree_run.tree_run_id,
                ContinuousSqlTreeJobLockModel.fencing_token == tree_run.fencing_token,
                ContinuousSqlTreeJobLockModel.active.is_(True),
            )
            .values(lease_expires_at=expires_at)
        )
        if int(result.rowcount or 0) != expected:
            return False
        tree_run.lease_expires_at = expires_at
        self.db.add(tree_run)
        return True

    def release_tree_locks(
        self,
        tree_run: ContinuousSqlTreeRunModel,
        *,
        terminal_status: str,
        ended_at: str,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        self.db.execute(
            update(ContinuousSqlTreeJobLockModel)
            .where(
                ContinuousSqlTreeJobLockModel.tree_run_id == tree_run.tree_run_id,
                ContinuousSqlTreeJobLockModel.fencing_token == tree_run.fencing_token,
                ContinuousSqlTreeJobLockModel.active.is_(True),
            )
            .values(active=False, released_at=ended_at)
        )
        self.db.execute(
            update(ContinuousSqlTreeNodeRunModel)
            .where(ContinuousSqlTreeNodeRunModel.tree_run_id == tree_run.tree_run_id)
            .values(status=terminal_status, ended_at=ended_at)
        )
        tree_run.status = terminal_status
        tree_run.ended_at = ended_at
        tree_run.last_error_code = error_code
        tree_run.last_error_message = error_message
        self.db.add(tree_run)

    def get_incremental_binding(
        self,
        job_id: str,
        *,
        for_update: bool = False,
    ) -> ContinuousSqlIncrementalBindingModel | None:
        statement = select(ContinuousSqlIncrementalBindingModel).where(
            ContinuousSqlIncrementalBindingModel.job_id == job_id
        )
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalars(statement).first()

    def add_incremental_binding(
        self,
        binding: ContinuousSqlIncrementalBindingModel,
    ) -> ContinuousSqlIncrementalBindingModel:
        self.db.add(binding)
        self.db.flush()
        return binding

    def list_active_incremental_bindings(
        self,
    ) -> list[tuple[ContinuousSqlIncrementalBindingModel, ContinuousSqlJobModel]]:
        return list(self.db.execute(
            select(ContinuousSqlIncrementalBindingModel, ContinuousSqlJobModel)
            .join(
                ContinuousSqlJobModel,
                ContinuousSqlJobModel.id == ContinuousSqlIncrementalBindingModel.job_id,
            )
            .where(ContinuousSqlJobModel.desired_state == "running")
            .order_by(ContinuousSqlIncrementalBindingModel.updated_at.asc())
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
    binding: ContinuousSqlIncrementalBindingModel | None = None,
    dependencies: Iterable[ContinuousSqlDependencyModel] = (),
    tree_run: ContinuousSqlTreeRunModel | None = None,
    tree_nodes: Iterable[ContinuousSqlTreeNodeRunModel] = (),
    tree_locks: Iterable[ContinuousSqlTreeJobLockModel] = (),
) -> ContinuousSqlJob:
    resolved_locks = list(tree_locks)
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
        dependency_bindings=[dependency_to_schema(item) for item in dependencies],
        execution_tree=ContinuousSqlExecutionTree(
            sql_job_id=job.id,
            active_tree_run_id=tree_run.tree_run_id if tree_run is not None else None,
            locked_job_ids=[item.job_id for item in resolved_locks if item.active],
        ),
        active_tree_run=tree_run_to_schema(tree_run, tree_nodes, resolved_locks),
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
        incremental_binding=incremental_binding_payload(binding),
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
        job_to_schema_with_tree(job, repository)
        for job in jobs
    ]


def job_to_schema_with_tree(
    job: ContinuousSqlJobModel,
    repository: ContinuousSqlRepository,
) -> ContinuousSqlJob:
    tree_run = repository.active_tree_run(job.id)
    return job_to_schema(
        job,
        repository.get_run(job.active_run_id) if job.active_run_id else None,
        repository.get_incremental_binding(job.id),
        repository.list_dependencies(job.id),
        tree_run,
        repository.list_tree_nodes(tree_run.tree_run_id) if tree_run is not None else (),
        repository.list_tree_locks(tree_run.tree_run_id) if tree_run is not None else (),
    )


def tree_run_to_schema(
    tree_run: ContinuousSqlTreeRunModel | None,
    nodes: Iterable[ContinuousSqlTreeNodeRunModel] = (),
    locks: Iterable[ContinuousSqlTreeJobLockModel] = (),
) -> ContinuousSqlTreeRun | None:
    if tree_run is None:
        return None
    return ContinuousSqlTreeRun(
        tree_run_id=tree_run.tree_run_id,
        sql_job_id=tree_run.sql_job_id,
        continuous_sql_run_id=tree_run.continuous_sql_run_id,
        generation=int(tree_run.generation),
        trigger_type=tree_run.trigger_type,
        status=tree_run.status,
        fencing_token_hash=hashlib.sha256(tree_run.fencing_token.encode("utf-8")).hexdigest(),
        lease_expires_at=tree_run.lease_expires_at.isoformat(),
        input_dataset_revisions=dict(tree_run.input_dataset_revisions or {}),
        nodes=[ContinuousSqlTreeNodeRun(
            node_run_id=item.node_run_id,
            tree_run_id=item.tree_run_id,
            job_id=item.job_id,
            node_type=item.node_type,
            trigger_type=item.trigger_type,
            parent_run_id=item.parent_run_id,
            producer_run_id=item.producer_run_id,
            status=item.status,
            input_dataset_revisions=dict(item.input_dataset_revisions or {}),
            started_at=item.started_at,
            ended_at=item.ended_at,
        ) for item in nodes],
        locks=[ContinuousSqlTreeJobLock(
            job_id=item.job_id,
            node_run_id=item.node_run_id,
            lock_kind=item.lock_kind,
            generation=int(item.generation),
            fencing_token_hash=hashlib.sha256(item.fencing_token.encode("utf-8")).hexdigest(),
            lease_expires_at=item.lease_expires_at.isoformat(),
            active=bool(item.active),
        ) for item in locks],
        started_at=tree_run.started_at,
        ended_at=tree_run.ended_at,
        last_error_code=tree_run.last_error_code,
        last_error_message=tree_run.last_error_message,
    )


def dependency_to_schema(
    dependency: ContinuousSqlDependencyModel,
) -> ContinuousSqlDependencyBinding:
    return ContinuousSqlDependencyBinding(
        sql_job_id=dependency.sql_job_id,
        input_dataset_id=dependency.input_dataset_id,
        child_job_id=dependency.child_job_id,
        input_type=dependency.input_type,
        execution_policy=dependency.execution_policy,
        required=bool(dependency.required),
    )


def incremental_binding_payload(
    binding: ContinuousSqlIncrementalBindingModel | None,
) -> dict | None:
    if binding is None:
        return None
    return {
        "baselineDatasetId": binding.baseline_dataset_id,
        "baselineRevision": int(binding.baseline_revision),
        "baselineSnapshotId": binding.baseline_snapshot_id,
        "fullRefreshCount": int(binding.full_refresh_count or 0),
        "nextOffsets": list(binding.next_offsets or []),
        "outputRevision": int(binding.output_revision or 0),
        "processedRows": int(binding.processed_rows or 0),
        "processedStaticKeys": int(binding.processed_static_keys or 0),
        "sourceDatasetId": binding.source_dataset_id,
        "sourceFingerprint": binding.source_fingerprint,
        "sourceRanges": list(binding.source_ranges or []),
        "sourceRevision": int(binding.source_revision or 0),
        "sourceRunId": binding.source_run_id,
        "staticSnapshots": list(binding.static_snapshots or []),
        "status": binding.status,
    }


def output_commit_identity(value: dict) -> tuple[str, dict]:
    return (
        str(value.get("snapshotId") or value.get("snapshot_id") or ""),
        dict(value.get("sourceBoundary") or value.get("source_boundary") or {}),
    )
