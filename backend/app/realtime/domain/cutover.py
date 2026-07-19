from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Literal

from app.realtime.domain.source_boundary import SourceBoundary


SwitchAction = Literal["cutover", "rollback"]
ServingEngine = Literal["clickhouse", "trino"]


@dataclass(frozen=True)
class CutoverGateEvidence:
    deterministic_fixture_rows: int
    lost_source_positions: int
    logical_duplicate_count: int
    shadow_observation_hours: int
    shadow_parity_passed: bool
    p95_slo_passed: bool
    restart_chaos_passed: bool
    security_passed: bool
    rollback_drill_passed: bool
    operations_dashboard_ready: bool
    runbook_ready: bool

    @property
    def failed_gates(self) -> tuple[str, ...]:
        checks = (
            ("deterministicFixture", self.deterministic_fixture_rows >= 100_000),
            ("sourcePositionLoss", self.lost_source_positions == 0),
            ("logicalDuplicates", self.logical_duplicate_count == 0),
            ("shadow72Hours", self.shadow_observation_hours >= 72),
            ("shadowParity", self.shadow_parity_passed),
            ("p95Slo", self.p95_slo_passed),
            ("restartChaos", self.restart_chaos_passed),
            ("security", self.security_passed),
            ("rollbackDrill", self.rollback_drill_passed),
            ("operationsDashboard", self.operations_dashboard_ready),
            ("runbook", self.runbook_ready),
        )
        return tuple(name for name, passed in checks if not passed)

    @property
    def approved(self) -> bool:
        return not self.failed_gates

    def document(self) -> dict[str, object]:
        return {
            "deterministicFixtureRows": self.deterministic_fixture_rows,
            "lostSourcePositions": self.lost_source_positions,
            "logicalDuplicateCount": self.logical_duplicate_count,
            "shadowObservationHours": self.shadow_observation_hours,
            "shadowParityPassed": self.shadow_parity_passed,
            "p95SloPassed": self.p95_slo_passed,
            "restartChaosPassed": self.restart_chaos_passed,
            "securityPassed": self.security_passed,
            "rollbackDrillPassed": self.rollback_drill_passed,
            "operationsDashboardReady": self.operations_dashboard_ready,
            "runbookReady": self.runbook_ready,
            "approved": self.approved,
            "failedGates": list(self.failed_gates),
        }


@dataclass(frozen=True)
class PhysicalBindingTarget:
    engine: ServingEngine
    version_id: str
    pipeline_version_id: str
    materialization_id: str
    boundary: SourceBoundary
    dimension_version_ids: dict[str, str]
    checksum: str
    row_count: int
    database: str | None = None
    table: str | None = None
    catalog: str | None = None
    schema: str | None = None
    archive_snapshot_id: str | None = None

    def __post_init__(self) -> None:
        identities = (
            self.version_id,
            self.pipeline_version_id,
            self.materialization_id,
            self.checksum,
        )
        if self.engine not in {"clickhouse", "trino"} or any(not value.strip() for value in identities):
            raise ValueError("serving binding target identity is incomplete")
        if self.row_count < 0:
            raise ValueError("serving binding row count cannot be negative")
        if self.engine == "clickhouse" and not (self.database and self.table):
            raise ValueError("ClickHouse target requires database and table")
        if self.engine == "trino" and not (self.catalog and self.schema and self.table):
            raise ValueError("Trino target requires catalog, schema, and table")
        dimensions = dict(sorted(self.dimension_version_ids.items()))
        if any(not key.strip() or not value.strip() for key, value in dimensions.items()):
            raise ValueError("serving binding dimension identity is invalid")
        object.__setattr__(self, "dimension_version_ids", dimensions)

    def document(self, *, binding_epoch: int, status: str = "active") -> dict[str, object]:
        document: dict[str, object] = {
            "role": "serving" if self.engine == "clickhouse" else "archive",
            "engine": self.engine,
            "status": status,
            "bindingEpoch": binding_epoch,
            "versionId": self.version_id,
            "pipelineVersionId": self.pipeline_version_id,
            "materializationId": self.materialization_id,
            "sourceBoundary": self.boundary.document(),
            "checksum": self.checksum,
            "rowCount": self.row_count,
            "dimensionVersionIds": dict(self.dimension_version_ids),
        }
        if self.engine == "clickhouse":
            document.update({"database": self.database, "table": self.table})
        else:
            document.update({
                "catalog": self.catalog,
                "schema": self.schema,
                "table": self.table,
                "snapshotId": self.archive_snapshot_id,
            })
        return document

    def storage_location(self) -> str:
        if self.engine == "clickhouse":
            return f"clickhouse://{self.database}/{self.table}"
        return f"trino://{self.catalog}/{self.schema}/{self.table}"


@dataclass(frozen=True)
class BindingSwitchRequest:
    idempotency_key: str
    action: SwitchAction
    dataset_id: str
    expected_binding_epoch: int
    expected_binding_version_id: str
    target: PhysicalBindingTarget
    parity_report_id: str
    requested_by: str
    reason: str
    correlation_id: str
    gate: CutoverGateEvidence | None = None

    def __post_init__(self) -> None:
        identities = (
            self.idempotency_key,
            self.dataset_id,
            self.expected_binding_version_id,
            self.parity_report_id,
            self.requested_by,
            self.correlation_id,
        )
        if self.action not in {"cutover", "rollback"} or any(not value.strip() for value in identities):
            raise ValueError("binding switch identity is incomplete")
        if len(self.idempotency_key) > 256 or self.expected_binding_epoch < 0:
            raise ValueError("binding switch idempotency key or epoch is invalid")
        if len(self.reason.strip()) < 10 or len(self.reason) > 2_000:
            raise ValueError("binding switch requires an audited reason")
        if self.action == "cutover" and (self.gate is None or not self.gate.approved):
            failed = self.gate.failed_gates if self.gate is not None else ("missingGateEvidence",)
            raise ValueError("cutover gate is not approved: " + ", ".join(failed))

    @property
    def operation_id(self) -> str:
        digest = hashlib.sha256(
            f"binding-switch|{self.idempotency_key}".encode("utf-8")
        ).hexdigest()
        return f"rtswitch_{digest}"


@dataclass(frozen=True)
class BindingSwitchResult:
    operation_id: str
    dataset_id: str
    binding_epoch: int
    revision: int
    event_cursor: int
    created: bool
