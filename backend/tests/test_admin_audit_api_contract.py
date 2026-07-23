from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.admin import get_identity_service, router as admin_router
from app.core.auth_context import ActorContext, get_actor_context
from app.models.identity import AuditEventModel
from app.services.identity_service import IdentityService


@contextmanager
def admin_audit_client(*target_types: str) -> Iterator[TestClient]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    AuditEventModel.metadata.create_all(engine, tables=[AuditEventModel.__table__])

    with Session(engine) as db:
        for index, target_type in enumerate(target_types):
            db.add(AuditEventModel(
                id=f"audit-{index}",
                action="contract.api.view",
                actor_id="admin-user",
                actor_name="Admin User",
                actor_role="admin",
                actor_groups=[],
                api_path="/api/admin/audit-logs",
                request_id=f"request-{index}",
                result="success",
                status_code=200,
                target_id=f"target-{index}",
                target_name=None,
                target_type=target_type,
                http_method="GET",
                metadata_={"index": index},
            ))
        db.commit()

        app = FastAPI()
        app.include_router(admin_router, prefix="/api")
        app.dependency_overrides[get_identity_service] = lambda: IdentityService(db)
        app.dependency_overrides[get_actor_context] = lambda: ActorContext(
            id="admin-user",
            name="Admin User",
            role="admin",
        )
        with TestClient(app) as client:
            yield client

    engine.dispose()


def test_admin_audit_http_response_serializes_query_run_and_legacy_rows() -> None:
    with admin_audit_client("query_run", "legacy_query_job") as client:
        response = client.get("/api/admin/audit-logs")

    assert response.status_code == 200
    logs = {log["targetId"]: log for log in response.json()["logs"]}
    assert logs["target-0"]["targetType"] == "query_run"
    assert logs["target-1"]["targetType"] == "unknown"
    assert logs["target-1"]["metadata"] == {
        "index": 1,
        "rawTargetType": "legacy_query_job",
    }


def test_unknown_http_filter_returns_only_unknown_and_legacy_rows() -> None:
    with admin_audit_client("dataset", "legacy_query_job", "unknown") as client:
        response = client.get("/api/admin/audit-logs", params={"resourceType": "unknown"})

    assert response.status_code == 200
    assert {log["targetId"] for log in response.json()["logs"]} == {
        "target-1",
        "target-2",
    }


def test_admin_audit_http_query_rejects_non_contract_target_type() -> None:
    with admin_audit_client() as client:
        response = client.get(
            "/api/admin/audit-logs",
            params={"resourceType": "future_target"},
        )

    assert response.status_code == 422


def test_admin_audit_openapi_uses_the_canonical_target_type_enum() -> None:
    with admin_audit_client() as client:
        schema = client.get("/openapi.json").json()

    enum_values = schema["components"]["schemas"]["AuditTargetType"]["enum"]
    assert "query_run" in enum_values
    assert "unknown" in enum_values
