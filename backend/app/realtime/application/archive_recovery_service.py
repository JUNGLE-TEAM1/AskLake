from __future__ import annotations

from app.realtime.domain.archive import (
    ArchiveParityReport,
    ParityEvidence,
    RebuildCompletionEvidence,
    RebuildPlan,
)
from app.realtime.domain.cutover import BindingSwitchRequest, BindingSwitchResult
from app.realtime.repositories.recovery_repository import RealtimeRecoveryRepository


class ArchiveRecoveryService:
    def __init__(self, repository: RealtimeRecoveryRepository) -> None:
        self.repository = repository

    def assess_parity(
        self,
        hot: ParityEvidence,
        archive: ParityEvidence,
    ) -> ArchiveParityReport:
        report = ArchiveParityReport.compare(hot, archive)
        self.repository.record_parity(report)
        return report

    def plan_rebuild(
        self,
        report: ArchiveParityReport,
        *,
        shadow_binding_version_id: str,
        physical_database: str,
        physical_table: str,
        expected_binding_epoch: int,
        requested_by: str,
        reason: str,
        correlation_id: str,
    ) -> RebuildPlan:
        plan = RebuildPlan.build(
            report,
            shadow_binding_version_id=shadow_binding_version_id,
            physical_database=physical_database,
            physical_table=physical_table,
        )
        self.repository.reserve_rebuild(
            plan,
            expected_binding_epoch=expected_binding_epoch,
            requested_by=requested_by,
            reason=reason,
            correlation_id=correlation_id,
        )
        return plan

    def start_rebuild(self, operation_id: str) -> bool:
        return self.repository.mark_rebuild_running(operation_id)

    def verify_rebuild(
        self,
        operation_id: str,
        evidence: RebuildCompletionEvidence,
    ) -> bool:
        return self.repository.mark_rebuild_ready(operation_id, evidence)

    def switch_binding(self, request: BindingSwitchRequest) -> BindingSwitchResult:
        return self.repository.switch_binding(request)
