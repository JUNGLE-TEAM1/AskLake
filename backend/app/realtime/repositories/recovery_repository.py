from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel, DatasetRevisionCommitModel
from app.models.realtime import (
    RealtimeParityCheckModel,
    RealtimeRecoveryOperationModel,
    RealtimeRoutingAssignmentModel,
)
from app.realtime.domain.archive import (
    ArchiveParityReport,
    RebuildCompletionEvidence,
    RebuildPlan,
)
from app.realtime.domain.cutover import BindingSwitchRequest, BindingSwitchResult
from app.repositories.catalog_repository import dataset_model_to_payload
from app.repositories.realtime_event_repository import RealtimeEventRepository


class RealtimeRecoveryRepository:
    """Persistent archive/recovery coordinator. The caller owns the transaction."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def record_parity(self, report: ArchiveParityReport) -> tuple[RealtimeParityCheckModel, bool]:
        existing = self.session.get(RealtimeParityCheckModel, report.report_id)
        if existing is not None:
            self._validate_parity_record(existing, report)
            return existing, False
        model = RealtimeParityCheckModel(
            id=report.report_id,
            dataset_id=report.hot.dataset_id,
            pipeline_version_id=report.hot.pipeline_version_id,
            hot_binding_version_id=report.hot.binding_version_id,
            archive_binding_version_id=report.archive.binding_version_id,
            source_boundary=report.hot.boundary.document(),
            dimension_version_ids=dict(report.hot.dimension_version_ids),
            hot_evidence=report.hot.document(),
            archive_evidence=report.archive.document(),
            status=report.status,
            mismatch_fields=list(report.mismatch_fields),
        )
        self.session.add(model)
        self.session.flush()
        return model, True

    def reserve_rebuild(
        self,
        plan: RebuildPlan,
        *,
        expected_binding_epoch: int,
        requested_by: str,
        reason: str,
        correlation_id: str,
    ) -> tuple[RealtimeRecoveryOperationModel, bool]:
        self._validate_audit(expected_binding_epoch, requested_by, reason, correlation_id)
        existing = self._operation_by_idempotency(plan.idempotency_key)
        if existing is not None:
            self._validate_rebuild_operation(existing, plan)
            return existing, False
        parity = self._matched_parity(plan.parity_report_id)
        if any((
            parity.dataset_id != plan.dataset_id,
            parity.pipeline_version_id != plan.pipeline_version_id,
            dict(parity.source_boundary) != plan.boundary.document(),
            dict(parity.dimension_version_ids) != plan.dimension_version_ids,
        )):
            raise ValueError("rebuild plan does not match persisted parity evidence")
        target_binding = {
            "role": "serving",
            "engine": "clickhouse",
            "status": "shadow",
            "bindingEpoch": expected_binding_epoch,
            "versionId": plan.shadow_binding_version_id,
            "pipelineVersionId": plan.pipeline_version_id,
            "database": plan.physical_database,
            "table": plan.physical_table,
            "sourceBoundary": plan.boundary.document(),
            "dimensionVersionIds": dict(plan.dimension_version_ids),
        }
        model = RealtimeRecoveryOperationModel(
            id=plan.operation_id,
            idempotency_key=plan.idempotency_key,
            dataset_id=plan.dataset_id,
            operation_kind="rebuild",
            status="planned",
            parity_check_id=plan.parity_report_id,
            expected_binding_epoch=expected_binding_epoch,
            target_binding_version_id=plan.shadow_binding_version_id,
            target_engine="clickhouse",
            pipeline_version_id=plan.pipeline_version_id,
            target_binding=target_binding,
            source_boundary=plan.boundary.document(),
            dimension_version_ids=dict(plan.dimension_version_ids),
            tail_start_offsets=list(plan.tail_start_offsets),
            gate_evidence={},
            requested_by=requested_by,
            reason=reason,
            correlation_id=correlation_id,
        )
        self.session.add(model)
        self.session.flush()
        return model, True

    def mark_rebuild_running(self, operation_id: str) -> bool:
        operation = self._locked_operation(operation_id)
        if operation.operation_kind != "rebuild":
            raise ValueError("recovery operation is not a rebuild")
        if operation.status in {"running", "ready", "completed"}:
            return False
        if operation.status not in {"planned", "failed"}:
            raise ValueError("rebuild cannot start from its current state")
        operation.status = "running"
        operation.attempt_count = int(operation.attempt_count or 0) + 1
        operation.last_error_code = None
        operation.updated_at = datetime.now(UTC)
        self.session.add(operation)
        self.session.flush()
        return True

    def mark_rebuild_ready(
        self,
        operation_id: str,
        evidence: RebuildCompletionEvidence,
    ) -> bool:
        operation = self._locked_operation(operation_id)
        if operation.operation_kind != "rebuild":
            raise ValueError("recovery operation is not a rebuild")
        if operation.status == "ready" and operation.parity_check_id == evidence.parity_report_id:
            return False
        if operation.status != "running":
            raise ValueError("only a running rebuild can become ready")
        parity = self._matched_parity(evidence.parity_report_id)
        if any((
            parity.dataset_id != operation.dataset_id,
            parity.pipeline_version_id != operation.pipeline_version_id,
            parity.hot_binding_version_id != operation.target_binding_version_id,
            dict(parity.source_boundary) != dict(operation.source_boundary),
            dict(parity.dimension_version_ids) != dict(operation.dimension_version_ids),
        )):
            raise ValueError("rebuilt shadow does not match its fixed boundary and versions")
        operation.parity_check_id = evidence.parity_report_id
        operation.status = "ready"
        operation.updated_at = datetime.now(UTC)
        self.session.add(operation)
        self.session.flush()
        return True

    def mark_rebuild_failed(self, operation_id: str, error_code: str) -> None:
        operation = self._locked_operation(operation_id)
        if operation.operation_kind != "rebuild" or operation.status != "running":
            raise ValueError("only a running rebuild can fail")
        if not error_code.strip() or len(error_code) > 120:
            raise ValueError("rebuild error code is invalid")
        operation.status = "failed"
        operation.last_error_code = error_code
        operation.updated_at = datetime.now(UTC)
        self.session.add(operation)
        self.session.flush()

    def switch_binding(self, request: BindingSwitchRequest) -> BindingSwitchResult:
        existing = self._operation_by_idempotency(request.idempotency_key)
        if existing is not None:
            return self._existing_switch_result(existing, request)

        freshness = self.session.scalars(
            select(DatasetFreshnessModel)
            .where(DatasetFreshnessModel.dataset_id == request.dataset_id)
            .with_for_update()
        ).first()
        if freshness is None:
            raise ValueError("Dataset serving binding is not initialized")
        existing = self._operation_by_idempotency(request.idempotency_key)
        if existing is not None:
            return self._existing_switch_result(existing, request)
        if any((
            int(freshness.binding_epoch or 0) != request.expected_binding_epoch,
            freshness.active_serving_version_id != request.expected_binding_version_id,
        )):
            raise ValueError("Dataset serving binding changed after switch approval")

        catalog = self.session.scalars(
            select(CatalogDatasetModel)
            .where(CatalogDatasetModel.id == request.dataset_id)
            .with_for_update()
        ).first()
        if catalog is None:
            raise ValueError("Catalog Dataset is missing for binding switch")
        payload = dataset_model_to_payload(catalog)
        current = self._active_binding(payload, str(freshness.active_serving_engine or ""))
        if current is None or current.get("versionId") != request.expected_binding_version_id:
            raise ValueError("Catalog active serving pointer changed after switch approval")

        parity = self._matched_parity(request.parity_report_id)
        self._validate_switch_parity(parity, request)
        now = datetime.now(UTC)
        epoch = request.expected_binding_epoch + 1
        revision = int(freshness.latest_revision or 0) + 1
        operation = RealtimeRecoveryOperationModel(
            id=request.operation_id,
            idempotency_key=request.idempotency_key,
            dataset_id=request.dataset_id,
            operation_kind=request.action,
            status="completed",
            parity_check_id=request.parity_report_id,
            expected_binding_epoch=request.expected_binding_epoch,
            previous_binding_version_id=request.expected_binding_version_id,
            target_binding_version_id=request.target.version_id,
            target_engine=request.target.engine,
            pipeline_version_id=request.target.pipeline_version_id,
            target_binding=request.target.document(binding_epoch=epoch),
            source_boundary=request.target.boundary.document(),
            dimension_version_ids=dict(request.target.dimension_version_ids),
            tail_start_offsets=[],
            gate_evidence=request.gate.document() if request.gate else {},
            attempt_count=1,
            result_binding_epoch=epoch,
            result_revision=revision,
            requested_by=request.requested_by,
            reason=request.reason,
            correlation_id=request.correlation_id,
            completed_at=now,
            updated_at=now,
        )
        self.session.add(operation)
        self._replace_catalog_binding(catalog, payload, request, epoch)

        recovery_materialization_id = f"recovery:{request.operation_id}"
        run_id = f"recovery:{request.operation_id}"
        self.session.add(DatasetRevisionCommitModel(
            dataset_id=request.dataset_id,
            revision=revision,
            run_id=run_id,
            storage_location=request.target.storage_location(),
            storage_format=request.target.engine,
            materialization_mode="snapshot",
            commit_kind=request.action,
            row_count=request.target.row_count,
            source_ranges=[item.document() for item in request.target.boundary.partitions],
            source_fingerprint=request.target.boundary.fingerprint(
                request.target.pipeline_version_id
            ),
            materialization_id=recovery_materialization_id,
            source_boundary=request.target.boundary.document(),
            serving_engine=request.target.engine,
            serving_version_id=request.target.version_id,
            binding_epoch=epoch,
            dimension_version_ids=dict(request.target.dimension_version_ids),
            mutation_type="replace",
            committed_at=now,
        ))
        freshness.latest_revision = revision
        freshness.latest_run_id = run_id
        freshness.binding_epoch = epoch
        freshness.active_serving_engine = request.target.engine
        freshness.active_serving_version_id = request.target.version_id
        if request.target.engine == "trino":
            freshness.active_archive_snapshot_id = request.target.archive_snapshot_id
        freshness.latest_source_boundary = request.target.boundary.document()
        freshness.latest_checksum = request.target.checksum
        freshness.latest_mutation_type = "replace"
        freshness.updated_at = now
        self.session.add(freshness)
        self._upsert_assignment(request, epoch, now)
        self.session.flush()

        envelope, created = RealtimeEventRepository(self.session).append(
            event_type="dataset.revision.committed",
            resource_type="dataset",
            resource_id=request.dataset_id,
            aggregate_revision=revision,
            correlation_id=request.correlation_id,
            idempotency_key=f"binding-switch:{request.operation_id}",
            invalidations=[f"dataset:{request.dataset_id}"],
            payload={
                "bindingEpoch": epoch,
                "materializationId": request.target.materialization_id,
                "mutationType": "replace",
                "sourceBoundary": request.target.boundary.document(),
                "servingVersionId": request.target.version_id,
                "pipelineVersionId": request.target.pipeline_version_id,
            },
            occurred_at=now,
            schema_version=2,
        )
        if not created:
            raise RuntimeError("new binding switch collided with an existing event identity")
        operation.result_event_cursor = envelope.event_id
        self.session.add(operation)
        self.session.flush()
        return BindingSwitchResult(
            operation_id=operation.id,
            dataset_id=request.dataset_id,
            binding_epoch=epoch,
            revision=revision,
            event_cursor=envelope.event_id,
            created=True,
        )

    @staticmethod
    def _validate_audit(epoch: int, requested_by: str, reason: str, correlation_id: str) -> None:
        if epoch < 0 or not requested_by.strip() or not correlation_id.strip():
            raise ValueError("recovery audit identity is invalid")
        if len(reason.strip()) < 10 or len(reason) > 2_000:
            raise ValueError("recovery requires an audited reason")

    @staticmethod
    def _validate_parity_record(
        model: RealtimeParityCheckModel,
        report: ArchiveParityReport,
    ) -> None:
        if any((
            model.hot_evidence != report.hot.document(),
            model.archive_evidence != report.archive.document(),
            model.status != report.status,
            list(model.mismatch_fields) != list(report.mismatch_fields),
        )):
            raise ValueError("parity report id was reused with different evidence")

    def _matched_parity(self, report_id: str) -> RealtimeParityCheckModel:
        parity = self.session.get(RealtimeParityCheckModel, report_id)
        if parity is None or parity.status != "matched" or parity.mismatch_fields:
            raise ValueError("operation requires persisted matched parity evidence")
        return parity

    def _operation_by_idempotency(self, key: str) -> RealtimeRecoveryOperationModel | None:
        return self.session.scalars(
            select(RealtimeRecoveryOperationModel).where(
                RealtimeRecoveryOperationModel.idempotency_key == key
            )
        ).first()

    def _locked_operation(self, operation_id: str) -> RealtimeRecoveryOperationModel:
        operation = self.session.scalars(
            select(RealtimeRecoveryOperationModel)
            .where(RealtimeRecoveryOperationModel.id == operation_id)
            .with_for_update()
        ).first()
        if operation is None:
            raise ValueError("recovery operation does not exist")
        return operation

    @staticmethod
    def _validate_rebuild_operation(
        operation: RealtimeRecoveryOperationModel,
        plan: RebuildPlan,
    ) -> None:
        if any((
            operation.operation_kind != "rebuild",
            operation.id != plan.operation_id,
            operation.dataset_id != plan.dataset_id,
            operation.parity_check_id != plan.parity_report_id,
            operation.target_binding_version_id != plan.shadow_binding_version_id,
            dict(operation.source_boundary) != plan.boundary.document(),
        )):
            raise ValueError("rebuild idempotency key was reused with different evidence")

    def _existing_switch_result(
        self,
        operation: RealtimeRecoveryOperationModel,
        request: BindingSwitchRequest,
    ) -> BindingSwitchResult:
        if any((
            operation.id != request.operation_id,
            operation.operation_kind != request.action,
            operation.dataset_id != request.dataset_id,
            operation.target_binding_version_id != request.target.version_id,
            operation.parity_check_id != request.parity_report_id,
            operation.status != "completed",
            operation.result_binding_epoch is None,
            operation.result_revision is None,
            operation.result_event_cursor is None,
        )):
            raise ValueError("binding switch idempotency key was reused with different evidence")
        return BindingSwitchResult(
            operation_id=operation.id,
            dataset_id=operation.dataset_id,
            binding_epoch=int(operation.result_binding_epoch),
            revision=int(operation.result_revision),
            event_cursor=int(operation.result_event_cursor),
            created=False,
        )

    @staticmethod
    def _active_binding(
        payload: dict[str, object],
        engine: str,
    ) -> dict[str, object] | None:
        bindings = payload.get("physicalBindings")
        if not isinstance(bindings, list):
            return None
        role = "archive" if engine == "trino" else "serving"
        return next((
            item for item in bindings
            if isinstance(item, dict)
            and item.get("role") == role
            and item.get("engine") == engine
            and item.get("status") == "active"
        ), None)

    @staticmethod
    def _validate_switch_parity(
        parity: RealtimeParityCheckModel,
        request: BindingSwitchRequest,
    ) -> None:
        target_version = request.target.version_id
        if target_version == parity.hot_binding_version_id:
            target_evidence = parity.hot_evidence
        elif target_version == parity.archive_binding_version_id:
            target_evidence = parity.archive_evidence
        else:
            raise ValueError("switch target is not covered by matched parity evidence")
        if any((
            parity.dataset_id != request.dataset_id,
            parity.pipeline_version_id != request.target.pipeline_version_id,
            dict(parity.source_boundary) != request.target.boundary.document(),
            dict(parity.dimension_version_ids) != request.target.dimension_version_ids,
            target_evidence.get("checksum") != request.target.checksum,
            int(target_evidence.get("rowCount", -1)) != request.target.row_count,
        )):
            raise ValueError("switch target does not match persisted parity evidence")

    def _replace_catalog_binding(
        self,
        catalog: CatalogDatasetModel,
        payload: dict[str, object],
        request: BindingSwitchRequest,
        epoch: int,
    ) -> None:
        raw_bindings = payload.get("physicalBindings")
        bindings = [dict(item) for item in raw_bindings if isinstance(item, dict)] \
            if isinstance(raw_bindings, list) else []
        target_role = "serving" if request.target.engine == "clickhouse" else "archive"
        retained: list[dict[str, object]] = []
        for binding in bindings:
            if binding.get("status") == "active" and binding.get("role") in {"serving", target_role}:
                binding["status"] = "stale"
            if not (
                binding.get("role") == target_role
                and binding.get("versionId") == request.target.version_id
            ):
                retained.append(binding)
        retained.append(request.target.document(binding_epoch=epoch))
        payload["physicalBindings"] = retained
        if request.target.engine == "clickhouse":
            payload["clickhouseTable"] = {
                "database": request.target.database,
                "table": request.target.table,
            }
        else:
            payload["queryEngineTable"] = {
                "catalog": request.target.catalog,
                "schema": request.target.schema,
                "table": request.target.table,
                "format": "iceberg",
                "partitionColumns": [],
            }
        catalog.payload = payload
        self.session.add(catalog)

    def _upsert_assignment(
        self,
        request: BindingSwitchRequest,
        epoch: int,
        now: datetime,
    ) -> None:
        assignment = self.session.get(
            RealtimeRoutingAssignmentModel,
            ("deployment", "dataset", request.dataset_id),
        )
        if assignment is None:
            assignment = RealtimeRoutingAssignmentModel(
                scope_id="deployment",
                resource_type="dataset",
                resource_id=request.dataset_id,
                desired_engine=request.target.engine,
                pipeline_version_id=request.target.pipeline_version_id,
                binding_epoch=epoch,
                status="active",
                assignment_reason=request.reason[:255],
                assigned_by=request.requested_by,
            )
        else:
            assignment.desired_engine = request.target.engine
            assignment.pipeline_version_id = request.target.pipeline_version_id
            assignment.binding_epoch = epoch
            assignment.status = "active"
            assignment.assignment_reason = request.reason[:255]
            assignment.assigned_by = request.requested_by
            assignment.updated_at = now
        self.session.add(assignment)
