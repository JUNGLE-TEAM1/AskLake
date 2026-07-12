import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.etl import ETLJobModel, ETLRunModel
from app.models.base import Base
from app.models.identity import PermissionGrantModel
from app.repositories import etl_repository
from app.repositories.permission_repository import create_permission_grant, list_permission_grants_by_resource
from app.schemas.etl import CreatePipelineRequest, UpdatePipelineRequest
from app.services import etl_service


def pipeline_payload() -> dict:
    return {
        "id": "permission-create-flow-contract",
        "jobName": "permission_create_flow_contract_pipeline",
        "owner": "data-platform",
        "permissionSummary": "Data Platform · 조직 내부",
        "permissionRoles": [{"access": ["조회", "실행", "관리"], "checked": True, "name": "Data Platform"}],
        "permissionGrants": [{
            "actions": ["view", "run"],
            "principalId": "demo-user",
            "principalType": "user",
            "source": "permission_ui",
        }],
        "qualityInvalidRows": [],
        "qualityRules": [],
        "qualityStatus": "pass",
        "rag": False,
        "retryPolicySummary": "재시도 없음",
        "runLimitSummary": "60분 제한",
        "ruleSummary": "permission contract",
        "scheduleLabel": "manual",
        "schemaColumns": [{
            "included": True,
            "nullable": False,
            "sourceName": "event_id",
            "targetName": "event_id",
            "type": "String",
        }],
        "schemaSampleRows": [["event-001"]],
        "schemaSummary": "1 column",
        "sourceConfig": [["Source", "contract"]],
        "sourceLabel": "contract source",
        "sourceType": "REST API",
        "storageType": "Local",
        "targetDataset": "permission_create_flow_contract",
        "targetFormat": "Parquet",
        "targetLayer": "GOLD",
        "transformOutputColumns": [["event_id", "string"]],
        "transformSteps": [],
    }


def main() -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[ETLJobModel.__table__, ETLRunModel.__table__, PermissionGrantModel.__table__])
    actor = ActorContext(name="Admin User", role="admin")
    original_ensure_schema = etl_repository.ensure_schema
    etl_repository.ensure_schema = lambda _db: None

    try:
        with Session(engine) as db:
            try:
                etl_service.get_permission_options(db, ActorContext(name="Demo User", role="viewer"))
            except ApiError as error:
                assert error.status_code == 403
            else:
                raise AssertionError("Permission options must require an admin actor")

            options = etl_service.get_permission_options(db, actor)
            assert any(group.id == "data-platform" for group in options.groups)
            assert any(user.id == "demo-user" for user in options.users)

            create_request = CreatePipelineRequest.model_validate(pipeline_payload())
            created = etl_service.create_pipeline(db, create_request, actor)
            job_id = created.job.id
            stored = list_permission_grants_by_resource(db, [("etl_job", job_id)])[("etl_job", job_id)]
            assert any(
                grant.principal_type == "user"
                and grant.principal_id == "demo-user"
                and grant.source == "permission_ui"
                and "run" in grant.actions
                for grant in stored
            )
            assert any(grant.principal_id == "demo-user" for grant in created.job.permission_grants)
            create_permission_grant(
                db,
                resource_type="etl_job",
                resource_id=job_id,
                principal_type="user",
                principal_id="admin-managed-user",
                actions=["view"],
                created_by=actor.name,
            )

            update_payload = {
                key: value
                for key, value in pipeline_payload().items()
                if key not in {"id", "sourceConfig", "sourceLabel", "sourceType"}
            }
            update_payload["permissionGrants"] = [{
                "actions": ["view", "query"],
                "principalId": "analytics",
                "principalType": "group",
                "source": "permission_ui",
            }]
            update_request = UpdatePipelineRequest.model_validate(update_payload)
            job_model = etl_repository.get_job(db, job_id)
            assert job_model is not None
            etl_service.apply_update_request(job_model, update_request, False)
            saved = etl_repository.save_job(db, job_model)
            updated = etl_service.persist_requested_permission_grants(
                db,
                saved,
                update_request.permission_grants,
                actor.name,
                actor,
            )
            replaced = list_permission_grants_by_resource(db, [("etl_job", job_id)])[("etl_job", job_id)]
            assert not any(grant.principal_id == "demo-user" and grant.source == "permission_ui" for grant in replaced)
            assert any(grant.principal_id == "analytics" and grant.source == "permission_ui" for grant in replaced)
            assert any(grant.principal_id == "admin-managed-user" and grant.source == "admin" for grant in replaced)
            assert any(grant.principal_id == "analytics" for grant in updated.permission_grants)
    finally:
        etl_repository.ensure_schema = original_ensure_schema

    print("verify-permission-create-flow-contract: ok")


if __name__ == "__main__":
    main()
