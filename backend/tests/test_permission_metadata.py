import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, can
from app.core.permission_metadata import permission_grants_from_roles
from app.models.base import Base
from app.models.identity import AuthUserModel, PermissionGrantModel
from app.repositories.permission_repository import list_permission_grants_by_resource
from app.schemas.etl import TrinoSqlJobGovernance
from app.services.etl_service import get_permission_options, trino_sql_job_permission_roles, trino_sql_job_permission_summary


def test_owner_is_a_real_user_principal_and_matches_actor_name() -> None:
    grants = permission_grants_from_roles("Alice", default_actions=["view", "manage"])

    assert grants == [{
        "actions": ["view", "manage"],
        "principalId": "Alice",
        "principalType": "user",
        "source": "owner",
    }]
    assert can(ActorContext(name="Alice", role="viewer"), "manage", grants=grants)


def test_sql_job_scope_uses_public_or_real_group_principals_without_fabricated_groups() -> None:
    organization_roles = trino_sql_job_permission_roles("organization", "Alice")
    project_roles = trino_sql_job_permission_roles("project", "Alice", "analytics")

    organization_grants = permission_grants_from_roles("Alice", organization_roles)
    project_grants = permission_grants_from_roles("Alice", project_roles)

    assert organization_grants[1]["principalType"] == "public"
    assert can(ActorContext(name="Bob", role="viewer"), "view", grants=organization_grants)
    assert project_grants[1]["principalType"] == "group"
    assert project_grants[1]["principalId"] == "analytics"
    assert can(ActorContext(name="Bob", role="viewer", groups=("analytics",)), "view", grants=project_grants)
    assert not can(ActorContext(name="Bob", role="viewer"), "view", grants=project_grants)
    assert trino_sql_job_permission_summary("project", "Alice", "analytics") == "그룹 analytics · 프로젝트 멤버"


def test_project_scope_rejects_missing_group_principal() -> None:
    with pytest.raises(ValidationError):
        TrinoSqlJobGovernance(accessScope="project", owner="Alice")


def test_permission_options_come_only_from_persisted_identity_directory() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[AuthUserModel.__table__])
    with Session(engine) as db:
        empty = get_permission_options(db, ActorContext(name="Admin", role="admin"))
        assert empty.groups == []
        assert empty.users == []

        db.add(AuthUserModel(
            id="alice-id",
            display_name="Alice",
            email="alice@example.com",
            groups=["analytics-real"],
            password_hash="hash",
            password_salt="salt",
            role="viewer",
            status="active",
        ))
        db.commit()

        options = get_permission_options(db, ActorContext(name="Admin", role="admin"))
        assert [group.id for group in options.groups] == ["analytics-real"]
        assert [user.id for user in options.users] == ["alice-id"]


def test_legacy_demo_grants_are_never_authorization_inputs() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[PermissionGrantModel.__table__])
    with Session(engine) as db:
        db.add_all([
            PermissionGrantModel(
                id="legacy",
                resource_type="dataset",
                resource_id="dataset-1",
                principal_type="group",
                principal_id="analytics",
                actions=["view", "query"],
                source="admin_seed",
                created_by="system",
            ),
            PermissionGrantModel(
                id="real",
                resource_type="dataset",
                resource_id="dataset-1",
                principal_type="group",
                principal_id="analytics-real",
                actions=["view"],
                source="admin",
                created_by="Admin",
            ),
        ])
        db.commit()

        grants = list_permission_grants_by_resource(db, [("dataset", "dataset-1")])
        assert [grant.id for grant in grants[("dataset", "dataset-1")]] == ["real"]
