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
from app.schemas.etl import CreatePipelineRequest, ReviewPipelineRequest, UpdatePipelineRequest
from app.services import etl_service


def pipeline_payload() -> dict:
    return {
        "id": "permission-create-flow-contract",
        "jobName": "permission_create_flow_contract_pipeline",
        "owner": "data-platform",
        "permissionSummary": "Data Platform · 조직 내부",
        "permissionRoles": [{"access": ["조회", "실행", "관리"], "checked": True, "name": "Data Platform"}],
        "permissionGrants": [
            {
                "actions": ["view", "run"],
                "principalId": "demo-user",
                "principalType": "user",
                "source": "permission_ui",
            },
            {
                "actions": ["view"],
                "principalId": "public",
                "principalType": "public",
                "source": "permission_ui",
            },
        ],
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
            viewer = ActorContext(name="Demo User", role="viewer", id="demo-user")
            create_options = etl_service.get_permission_options(db, viewer)
            assert any(group.id == "data-platform" for group in create_options.groups)
            assert any(user.id == "demo-user" for user in create_options.users)

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
            assert any(
                grant.principal_type == "public"
                and grant.principal_id == "public"
                and grant.actions == ["view"]
                and grant.source == "permission_ui"
                for grant in stored
            )
            assert any(grant.principal_id == "demo-user" for grant in created.job.permission_grants)
            assert not any(grant.source in {"owner", "permissionRoles"} for grant in created.job.permission_grants)

            review_request = ReviewPipelineRequest.model_validate(pipeline_payload())
            review = etl_service.review_pipeline(review_request)
            assert review.permission[0].label == "담당자 자동 권한"
            assert review.permission[0].value.startswith("data-platform · 조회")
            assert any(
                entry.label == "사용자 · demo-user" and "실행" in entry.value
                for entry in review.permission
            )
            assert any(
                entry.label == "모든 사용자 · 로그인한 사용자 전체" and entry.value == "조회"
                for entry in review.permission
            )

            owner_options = etl_service.get_permission_options(
                db,
                ActorContext(name=created.job.owner, role="viewer"),
                job_id,
            )
            assert any(group.id == "data-platform" for group in owner_options.groups)

            try:
                etl_service.get_permission_options(db, viewer, job_id)
            except ApiError as error:
                assert error.status_code == 403
            else:
                raise AssertionError("Unrelated viewers must not read permission options")

            created_by_options = etl_service.get_permission_options(
                db,
                ActorContext(name=actor.name, role="viewer"),
                job_id,
            )
            assert any(user.id == "demo-user" for user in created_by_options.users)

            create_permission_grant(
                db,
                resource_type="etl_job",
                resource_id=job_id,
                principal_type="user",
                principal_id="admin-managed-user",
                actions=["view"],
                created_by=actor.name,
            )
            create_permission_grant(
                db,
                resource_type="etl_job",
                resource_id=job_id,
                principal_type="user",
                principal_id="manager-user",
                actions=["manage"],
                created_by=actor.name,
            )
            manager_options = etl_service.get_permission_options(
                db,
                ActorContext(name="Manager User", role="viewer", id="manager-user"),
                job_id,
            )
            assert manager_options.groups
            manager_grants = list_permission_grants_by_resource(db, [("etl_job", job_id)])["etl_job", job_id]
            manager_grant = next(grant for grant in manager_grants if grant.principal_id == "manager-user")
            assert manager_grant.actions == ["manage", "view"]

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

            legacy_payload = pipeline_payload()
            legacy_payload["id"] = "legacy-permission-migration-contract"
            legacy_payload["jobName"] = "legacy_permission_migration_contract_pipeline"
            legacy_payload["owner"] = "legacy-owner"
            legacy_payload["targetDataset"] = "legacy_permission_migration_contract"
            legacy_payload.pop("permissionGrants")
            legacy_request = CreatePipelineRequest.model_validate(legacy_payload)
            legacy_created = etl_service.create_pipeline(db, legacy_request, actor)
            legacy_actor = ActorContext(
                name="Data Platform Member",
                role="viewer",
                groups=("data-platform",),
            )
            migrated = etl_service.with_job_permissions(db, legacy_created.job, legacy_actor)
            assert migrated.permissions.can_run is True
            assert migrated.permissions.can_manage is True
            assert any(
                grant.principal_type == "group"
                and grant.principal_id == "data-platform"
                and grant.source == "legacy_permission_roles"
                for grant in migrated.permission_grants
            )
            assert not any(grant.source == "owner" for grant in migrated.permission_grants)

            migrated_again = etl_service.with_job_permissions(db, legacy_created.job, legacy_actor)
            assert len([
                grant for grant in migrated_again.permission_grants
                if grant.source == "legacy_permission_roles"
            ]) == 1
    finally:
        etl_repository.ensure_schema = original_ensure_schema

    print("verify-permission-create-flow-contract: ok")


if __name__ == "__main__":
    main()
