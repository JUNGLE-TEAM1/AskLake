import re

from fastapi import status
from mcp.server.fastmcp import Context

from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.ai import AiContextClaims, CatalogDatasetContext
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.mcp.context import consume_ai_context_token, request_context_token, verify_ai_context_token


CATALOG_CONTEXT_TOOL_NAME = "asklake.catalog.get_dataset_context"
CATALOG_CONTEXT_BATCH_TOOL_NAME = "asklake.catalog.get_datasets_context"
DEFAULT_SAMPLE_ROW_LIMIT = 5
MAX_SAMPLE_ROW_LIMIT = 20
MAX_SCHEMA_COLUMNS = 256
MAX_SAMPLE_COLUMNS = 64
MAX_CONTEXT_LIST_ITEMS = 64
MAX_SAMPLE_VALUE_CHARS = 256


def get_dataset_context(
    dataset_id: str,
    context_token: str | None = None,
    sample_row_limit: int = DEFAULT_SAMPLE_ROW_LIMIT,
    request_id: str | None = None,
    ctx: Context = None,
) -> CatalogDatasetContext:
    """Read safe, bounded catalog context for one scoped dataset."""

    return _get_datasets_context(
        [dataset_id],
        context_token=context_token,
        sample_row_limit=sample_row_limit,
        request_id=request_id,
        ctx=ctx,
        tool_name=CATALOG_CONTEXT_TOOL_NAME,
    )[0]


def get_datasets_context(
    dataset_ids: list[str],
    context_token: str | None = None,
    sample_row_limit: int = DEFAULT_SAMPLE_ROW_LIMIT,
    request_id: str | None = None,
    ctx: Context = None,
) -> list[CatalogDatasetContext]:
    """Read safe, bounded catalog context for multiple scoped datasets."""

    return _get_datasets_context(
        dataset_ids,
        context_token=context_token,
        sample_row_limit=sample_row_limit,
        request_id=request_id,
        ctx=ctx,
        tool_name=CATALOG_CONTEXT_BATCH_TOOL_NAME,
    )


def _get_datasets_context(
    dataset_ids: list[str],
    *,
    context_token: str | None,
    sample_row_limit: int,
    request_id: str | None,
    ctx: Context,
    tool_name: str,
) -> list[CatalogDatasetContext]:
    token = context_token or _context_header(ctx)
    claims = verify_ai_context_token(token)
    if request_id is not None and request_id != claims.request_id:
        raise ApiError(
            ErrorCode.UNAUTHORIZED,
            "AI request identity does not match the signed context",
            status.HTTP_401_UNAUTHORIZED,
        )
    if not dataset_ids:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "At least one dataset is required",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    for dataset_id in dataset_ids:
        _require_scoped_dataset(claims, dataset_id)
        _require_query_permission(claims, dataset_id)
    if sample_row_limit < 0:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "sampleRowLimit must be zero or greater",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    bounded_sample_limit = min(
        sample_row_limit,
        MAX_SAMPLE_ROW_LIMIT,
        settings.ai_context_max_sample_rows,
    )

    actor = _actor_from_claims(claims)
    with SessionLocal() as db:
        consume_ai_context_token(db, token, claims)
        repository = CatalogRepository(db)
        contexts: list[CatalogDatasetContext] = []
        for dataset_id in dataset_ids:
            payload = repository.get_dataset_payload(dataset_id)
            if payload is None:
                raise ApiError(
                    ErrorCode.NOT_FOUND,
                    "Dataset not found",
                    status.HTTP_404_NOT_FOUND,
                )
            dataset = dataset_with_persisted_permission_grants(
                db,
                CatalogDatasetResponse.model_validate(payload),
            )
            require_governed_access(
                db,
                actor,
                action="query",
                api_path=f"/internal/mcp/{tool_name}",
                http_method="POST",
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            require_permission(
                actor,
                "query",
                owner=dataset.owner,
                grants=dataset.permission_grants,
                resource_label="dataset",
            )
            contexts.append(_safe_dataset_context(dataset, bounded_sample_limit))
        return contexts


def get_dataset_context_batch(
    dataset_ids: list[str],
    context_token: str | None = None,
    sample_row_limit: int = DEFAULT_SAMPLE_ROW_LIMIT,
    request_id: str | None = None,
    ctx: Context = None,
) -> list[CatalogDatasetContext]:
    """Backward-compatible alias for callers using the singular batch name."""

    return get_datasets_context(
        dataset_ids,
        context_token=context_token,
        sample_row_limit=sample_row_limit,
        request_id=request_id,
        ctx=ctx,
    )


def _require_scoped_dataset(claims: AiContextClaims, dataset_id: str) -> None:
    if dataset_id not in claims.allowed_dataset_ids:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "The AI context does not include this dataset",
            status.HTTP_403_FORBIDDEN,
        )


def _require_query_permission(claims: AiContextClaims, dataset_id: str) -> None:
    if "query" not in claims.dataset_permissions.get(dataset_id, []):
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "The AI context does not grant query permission for this dataset",
            status.HTTP_403_FORBIDDEN,
        )


def _actor_from_claims(claims: AiContextClaims) -> ActorContext:
    return ActorContext(
        name=claims.actor.name,
        role=claims.actor.role,
        groups=tuple(claims.actor.groups),
        id=claims.actor.id,
        email=claims.actor.email,
    )


def _context_header(ctx: Context) -> str | None:
    scoped_token = request_context_token()
    if scoped_token:
        return scoped_token
    if ctx is None:
        return None
    try:
        request = ctx.request_context.request
    except (AttributeError, ValueError):
        return None
    headers = getattr(request, "headers", None)
    if headers is None:
        return None
    return headers.get("x-asklake-ai-context")


def _safe_dataset_context(
    dataset: CatalogDatasetResponse,
    sample_row_limit: int,
) -> CatalogDatasetContext:
    bounded_schema = list(dataset.schema_[:MAX_SCHEMA_COLUMNS])
    sample_column_count = min(len(bounded_schema), MAX_SAMPLE_COLUMNS)
    sensitive_columns = {
        index
        for index, (column_name, _column_type) in enumerate(bounded_schema[:sample_column_count])
        if _is_sensitive_column(column_name)
    }
    sample_rows = []
    for row in dataset.sample_rows[:sample_row_limit]:
        sample_rows.append([
            _redact_sample_value(value, sensitive=index in sensitive_columns)
            for index, value in enumerate(row[:sample_column_count])
        ])
    return CatalogDatasetContext(
        dataset_id=str(dataset.id)[:255],
        dataset_name=str(dataset.name)[:255],
        description=str(dataset.description)[:2_000],
        layer=str(dataset.layer)[:64],
        freshness=str(dataset.freshness)[:64],
        last_updated=str(dataset.last_updated)[:128],
        quality=str(dataset.quality)[:128],
        row_count=str(dataset.rows)[:64],
        schema=[
            {"name": str(column_name)[:255], "type": str(column_type)[:128]}
            for column_name, column_type in bounded_schema
        ],
        schema_truncated=len(dataset.schema_) > len(bounded_schema),
        tags=[str(tag)[:255] for tag in dataset.tags[:MAX_CONTEXT_LIST_ITEMS]],
        upstream=[str(dataset_id)[:255] for dataset_id in dataset.upstream[:MAX_CONTEXT_LIST_ITEMS]],
        downstream=[str(dataset_id)[:255] for dataset_id in dataset.downstream[:MAX_CONTEXT_LIST_ITEMS]],
        sample_column_names=[str(column_name)[:255] for column_name, _ in bounded_schema[:sample_column_count]],
        sample_rows=sample_rows,
        sample_rows_truncated=(
            len(dataset.sample_rows) > len(sample_rows)
            or len(bounded_schema) > sample_column_count
            or any(len(row) > sample_column_count for row in dataset.sample_rows[:sample_row_limit])
        ),
    )


def _is_sensitive_column(column_name: str) -> bool:
    normalized = column_name.casefold().replace("-", "_")
    sensitive_markers = (
        "password",
        "passwd",
        "secret",
        "credential",
        "api_key",
        "access_key",
        "token",
        "private_key",
        "email",
        "e_mail",
        "phone",
        "mobile",
        "telephone",
        "address",
        "passport",
        "social_security",
        "national_id",
        "resident_id",
        "credit_card",
        "card_number",
        "bank_account",
        "account_number",
        "iban",
        "birth_date",
        "date_of_birth",
        "ip_address",
        "user_id",
        "customer_id",
        "reviewer_id",
    )
    return any(marker in normalized for marker in sensitive_markers)


_EMAIL_VALUE = re.compile(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b")
_PHONE_VALUE = re.compile(r"(?<!\d)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)\d{3,4}[ .-]?\d{4}(?!\d)")
_PAYMENT_CARD_VALUE = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")


def _redact_sample_value(value: object, *, sensitive: bool) -> str:
    if sensitive:
        return "[REDACTED]"
    text = str(value)
    text = _EMAIL_VALUE.sub("[REDACTED_EMAIL]", text)
    text = _PHONE_VALUE.sub("[REDACTED_PHONE]", text)
    text = _PAYMENT_CARD_VALUE.sub("[REDACTED_CARD]", text)
    return text[:MAX_SAMPLE_VALUE_CHARS]
