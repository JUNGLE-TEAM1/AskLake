from uuid import uuid4

from sqlalchemy import delete

from app.core.auth_context import ActorContext
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.models.identity import AuditEventModel
from app.models.sql import SqlRunModel
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoQueryRunResponse, TrinoQueryRunResult
from app.services.trino_query_run_service import TrinoQueryRunService


def payload(
    run_id: str,
    *,
    user_id: str | None,
    user_name: str,
    retention_expires_at: str | None = None,
) -> dict[str, object]:
    response = TrinoQueryRunResponse(
        baseDatasetId="ds_history_verify",
        query="SELECT 1",
        runId=run_id,
        status="succeeded",
        submittedAt="2026-07-11T00:00:00Z",
        submittedByName=user_name,
        submittedByUserId=user_id,
        result=TrinoQueryRunResult(
            retentionExpiresAt=retention_expires_at,
            storageStatus="expired" if retention_expires_at else "available",
        ) if retention_expires_at else None,
    )
    stored = response.model_dump(by_alias=True, exclude_none=True, mode="json")
    stored["compiledQuery"] = "SELECT 1"
    stored["trinoNextUri"] = None
    return stored


def verify() -> None:
    prefix = f"trino_history_verify_{uuid4().hex[:12]}"
    own_run_id = f"{prefix}_own"
    other_run_id = f"{prefix}_other"
    legacy_run_id = f"{prefix}_legacy"
    expired_run_id = f"{prefix}_expired"
    own_user_id = f"history-user-{prefix}"
    with SessionLocal() as db:
        repository = SqlRepository(db)
        try:
            repository.save_run_payload(payload(own_run_id, user_id=own_user_id, user_name="History User"))
            repository.save_run_payload(payload(other_run_id, user_id="other-user", user_name="History User"))
            repository.save_run_payload(payload(legacy_run_id, user_id=None, user_name="History User"))
            repository.save_run_payload(payload(
                expired_run_id,
                user_id=own_user_id,
                user_name="History User",
                retention_expires_at="2020-01-01T00:00:00Z",
            ))

            service = TrinoQueryRunService(repository, CatalogRepository(db))
            own_runs = service.list_for_actor(ActorContext(id=own_user_id, name="History User"), limit=10)
            own_run_ids = {item.run_id for item in own_runs.items}
            assert own_run_id in own_run_ids
            assert legacy_run_id in own_run_ids
            assert expired_run_id in own_run_ids
            assert other_run_id not in own_run_ids

            fallback_runs = repository.list_trino_run_payloads(actor_name="History User", limit=10)
            assert {item["runId"] for item in fallback_runs} == {own_run_id, other_run_id, legacy_run_id, expired_run_id}

            service.access_service.require_access_for_response = lambda *_args, **_kwargs: None  # type: ignore[method-assign]
            expired = service.get(expired_run_id, ActorContext(id=own_user_id, name="History User"))
            assert expired.result and expired.result.storage_status == "expired"
            try:
                service.get_result_page(expired_run_id, None, ActorContext(id=own_user_id, name="History User"))
            except ApiError as error:
                assert error.code == ErrorCode.RESULT_EXPIRED
            else:
                raise AssertionError("expired run result page must remain unavailable")
        finally:
            db.execute(delete(SqlRunModel).where(SqlRunModel.id.in_([own_run_id, other_run_id, legacy_run_id, expired_run_id])))
            db.execute(delete(AuditEventModel).where(AuditEventModel.actor_id == own_user_id))
            db.commit()


if __name__ == "__main__":
    verify()
    print("Trino Query Run history verification passed.")
