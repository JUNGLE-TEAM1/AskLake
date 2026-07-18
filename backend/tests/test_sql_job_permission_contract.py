import pytest
from pydantic import ValidationError

from app.application.etl_pipeline_policy import (
    trino_sql_job_permission_roles,
    trino_sql_job_permission_summary,
)
from app.core.errors import ApiError
from app.schemas.etl import TrinoSqlJobGovernance


def test_organization_scope_uses_authenticated_users_principal() -> None:
    roles = trino_sql_job_permission_roles("organization", "master@example.com")

    assert roles == [{
        "access": ["조회", "쿼리 실행", "메타데이터", "관리"],
        "checked": True,
        "name": "모든 인증 사용자",
        "principalId": "authenticated-users",
        "principalType": "public",
    }]
    assert trino_sql_job_permission_summary("organization", "master@example.com") == "모든 인증 사용자 · 조직 내부"


def test_private_scope_relies_on_owner_grant_without_duplicate_role() -> None:
    assert trino_sql_job_permission_roles("private", "master@example.com") == []
    assert trino_sql_job_permission_summary("private", "master@example.com") == "master@example.com · 소유자 전용"


def test_project_scope_uses_selected_group_principal() -> None:
    roles = trino_sql_job_permission_roles("project", "master@example.com", "analytics-team")

    assert roles[0]["principalId"] == "analytics-team"
    assert roles[0]["principalType"] == "group"
    assert trino_sql_job_permission_summary(
        "project",
        "master@example.com",
        "analytics-team",
    ) == "그룹 analytics-team · 프로젝트 멤버"


def test_project_scope_rejects_missing_group_principal() -> None:
    with pytest.raises(ApiError) as exc_info:
        trino_sql_job_permission_roles("project", "master@example.com")

    assert exc_info.value.code == "VALIDATION_ERROR"
    assert exc_info.value.status_code == 422

    with pytest.raises(ValidationError, match="real group principalId"):
        TrinoSqlJobGovernance(accessScope="project", owner="master@example.com")


def test_governance_normalizes_actual_owner_and_principal() -> None:
    governance = TrinoSqlJobGovernance(
        accessScope="project",
        owner="  master@example.com  ",
        principalId="  analytics-team  ",
    )

    assert governance.owner == "master@example.com"
    assert governance.principal_id == "analytics-team"
