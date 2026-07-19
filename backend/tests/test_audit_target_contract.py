from pathlib import Path
import re
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.domain.audit import AUDIT_TARGET_TYPES, AuditTargetType
from app.models.identity import AuditEventModel
from app.repositories.audit_repository import ALLOWED_AUDIT_TARGET_TYPES, add_audit_event
from app.schemas.identity import AdminAuditLogEntry
from app.services.identity_service import IdentityService


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_AUDIT_TYPES = REPOSITORY_ROOT / "frontend" / "src" / "types" / "audit.ts"
BACKEND_APP_ROOT = REPOSITORY_ROOT / "backend" / "app"


def frontend_audit_target_types() -> set[str]:
    source = FRONTEND_AUDIT_TYPES.read_text(encoding="utf-8")
    declaration = re.search(
        r"export type AuditTargetType\s*=\s*(.+?);",
        source,
        flags=re.DOTALL,
    )
    assert declaration is not None
    return set(re.findall(r'"([^"]+)"', declaration.group(1)))


def test_query_run_audit_event_is_serializable_for_admin_history() -> None:
    engine = create_engine("sqlite:///:memory:")
    AuditEventModel.metadata.create_all(engine, tables=[AuditEventModel.__table__])

    with Session(engine) as db:
        db.add(AuditEventModel(
            id="audit-query-run",
            action="query_run.history.view",
            actor_id="admin-user",
            actor_name="Admin User",
            actor_role="admin",
            actor_groups=[],
            api_path="/api/query/runs/query-run-1",
            request_id="request-query-run",
            result="success",
            status_code=200,
            target_id="query-run-1",
            target_name=None,
            target_type="query_run",
            http_method="GET",
            metadata_={},
        ))
        db.commit()

        response = IdentityService(db).list_admin_audit_logs(
            ActorContext(name="Admin User", role="admin"),
            limit=100,
        )

    assert len(response.logs) == 1
    assert response.logs[0].target_type == "query_run"


def test_legacy_unknown_target_type_does_not_break_admin_history() -> None:
    engine = create_engine("sqlite:///:memory:")
    AuditEventModel.metadata.create_all(engine, tables=[AuditEventModel.__table__])

    with Session(engine) as db:
        db.add(AuditEventModel(
            id="audit-legacy-target",
            action="legacy.audit.view",
            actor_id="admin-user",
            actor_name="Admin User",
            actor_role="admin",
            actor_groups=[],
            api_path="/api/legacy/audit",
            request_id="request-legacy-target",
            result="success",
            status_code=200,
            target_id="legacy-target-1",
            target_name=None,
            target_type="legacy_query_job",
            http_method="GET",
            metadata_={"existing": "evidence", "rawTargetType": "stale_value"},
        ))
        db.commit()

        response = IdentityService(db).list_admin_audit_logs(
            ActorContext(name="Admin User", role="admin"),
            limit=100,
        )

    assert len(response.logs) == 1
    assert response.logs[0].target_type == AuditTargetType.UNKNOWN
    assert response.logs[0].metadata == {
        "existing": "evidence",
        "rawTargetType": "legacy_query_job",
    }


def test_unknown_target_filter_matches_legacy_and_explicit_unknown_rows() -> None:
    engine = create_engine("sqlite:///:memory:")
    AuditEventModel.metadata.create_all(engine, tables=[AuditEventModel.__table__])

    with Session(engine) as db:
        for event_id, target_type in (
            ("audit-known", "dataset"),
            ("audit-legacy", "legacy_query_job"),
            ("audit-unknown", "unknown"),
        ):
            db.add(AuditEventModel(
                id=event_id,
                action="contract.filter",
                actor_id="admin-user",
                actor_name="Admin User",
                actor_role="admin",
                actor_groups=[],
                api_path="/api/admin/audit-logs",
                request_id=f"request-{event_id}",
                result="success",
                status_code=200,
                target_id=event_id,
                target_name=None,
                target_type=target_type,
                http_method="GET",
                metadata_={},
            ))
        db.commit()

        response = IdentityService(db).list_admin_audit_logs(
            ActorContext(name="Admin User", role="admin"),
            resource_type=AuditTargetType.UNKNOWN,
            limit=100,
        )

    assert {log.target_id for log in response.logs} == {"audit-legacy", "audit-unknown"}


def test_new_audit_target_type_requires_a_known_enum_member() -> None:
    engine = create_engine("sqlite:///:memory:")
    AuditEventModel.metadata.create_all(engine, tables=[AuditEventModel.__table__])
    actor = ActorContext(name="Admin User", role="admin", id="admin-user")

    with Session(engine) as db:
        row = add_audit_event(
            db,
            action="contract.write",
            actor=actor,
            api_path="/api/contract",
            target_id="dataset-1",
            target_type=AuditTargetType.DATASET,
            metadata={"existing": "evidence"},
        )
        db.flush()

        assert row.target_type == AuditTargetType.DATASET.value
        assert row.metadata_ == {"existing": "evidence"}

        with pytest.raises(TypeError, match="require AuditTargetType"):
            add_audit_event(
                db,
                action="contract.invalid_string_write",
                actor=actor,
                api_path="/api/contract",
                target_id="future-target-1",
                target_type="future_target",  # type: ignore[arg-type]
            )

        with pytest.raises(ValueError, match="reserved for legacy"):
            add_audit_event(
                db,
                action="contract.invalid_unknown_write",
                actor=actor,
                api_path="/api/contract",
                target_id="unknown-target-1",
                target_type=AuditTargetType.UNKNOWN,
            )


def test_production_audit_writers_do_not_use_string_literals() -> None:
    offenders: list[str] = []
    for path in BACKEND_APP_ROOT.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        if re.search(r"target_type\s*=\s*['\"]", source):
            offenders.append(str(path.relative_to(REPOSITORY_ROOT)))

    assert offenders == []


def test_backend_audit_target_type_contract_has_one_source() -> None:
    annotation = AdminAuditLogEntry.model_fields["target_type"].annotation

    assert annotation is AuditTargetType
    assert ALLOWED_AUDIT_TARGET_TYPES == AUDIT_TARGET_TYPES


def test_every_canonical_audit_target_type_is_serializable() -> None:
    for target_type in AuditTargetType:
        entry = AdminAuditLogEntry(
            action="contract.test",
            actor_id="contract-test",
            api_path="/api/admin/audit-logs",
            created_at="2026-07-19T00:00:00Z",
            request_id=f"request-{target_type.value}",
            result="success",
            target_id=f"target-{target_type.value}",
            target_type=target_type,
        )

        assert entry.model_dump(mode="json")["target_type"] == target_type.value


def test_frontend_audit_target_types_match_backend_contract() -> None:
    frontend_types = frontend_audit_target_types()

    assert AUDIT_TARGET_TYPES == frontend_types
