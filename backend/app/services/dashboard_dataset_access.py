from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.schemas.catalog import CatalogDatasetResponse
from app.services.governance_enforcement import require_governed_access


def require_dashboard_dataset_query_access(
    db: Session,
    actor: ActorContext,
    dataset: CatalogDatasetResponse,
    *,
    api_path: str,
    http_method: str,
) -> None:
    require_governed_access(
        db,
        actor,
        action="query",
        api_path=api_path,
        http_method=http_method,
        metadata={"owner": dataset.owner},
        resource_id=dataset.id,
        resource_name=dataset.name,
        resource_type="dataset",
    )
    try:
        require_permission(
            actor,
            "query",
            owner=dataset.owner,
            grants=dataset.permission_grants,
            resource_label="dataset",
        )
    except ApiError as exc:
        safe_record_audit_event(
            db,
            action="dataset.query.forbidden",
            actor=actor,
            api_path=api_path,
            http_method=http_method,
            metadata={"owner": dataset.owner},
            result="forbidden",
            status_code=exc.status_code,
            target_id=dataset.id,
            target_name=dataset.name,
            target_type="dataset",
        )
        raise
