from uuid import uuid4

from fastapi import status
from sqlglot import exp, parse_one
from sqlglot.errors import ParseError

from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryAiSuggestionRequest, QueryAiSuggestionResponse
from app.services.governance_enforcement import require_governed_access
from app.services.ai_gateway_client import AiGatewayClient
from app.services.ai_evidence import retain_used_rag_evidence
from app.mcp.context import issue_ai_context_token
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.services.sql_service import (
    build_dataset_context_map,
    extract_cte_names,
    extract_referenced_table_names,
    unique_dataset_ids,
    validate_read_only_query,
)
from app.services.semantic_rag_context import build_semantic_rag_context

PREVIEW_LIMIT = 100
QUERY_AI_SAMPLE_ROW_LIMIT = 5


class QueryAiService:
    def __init__(self, catalog_repository: CatalogRepository) -> None:
        self.catalog_repository = catalog_repository

    def create_suggestion(
        self,
        request: QueryAiSuggestionRequest,
        actor: ActorContext | None = None,
    ) -> QueryAiSuggestionResponse:
        actor_context = actor or ActorContext()
        if request.mode != "draft_sql":
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Only SQL draft suggestions are supported",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"mode": request.mode},
            )

        prompt = request.prompt.strip()
        if not prompt:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Natural language prompt is required",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        context_dataset_ids = unique_dataset_ids(
            [
                *(request.selected_dataset_ids or []),
                *([request.base_dataset_id] if request.base_dataset_id else []),
            ]
        )
        if not context_dataset_ids:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "At least one selected dataset is required",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        datasets = [
            self.get_catalog_dataset(dataset_id)
            for dataset_id in context_dataset_ids
        ]
        for dataset in datasets:
            require_governed_access(
                self.catalog_repository.db,
                actor_context,
                action="query",
                api_path="/api/query/ai-suggestions",
                http_method="POST",
                metadata={"owner": dataset.owner},
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            require_permission(
                actor_context,
                "query",
                owner=dataset.owner,
                grants=dataset.permission_grants,
                resource_label="dataset",
            )
        base_dataset = self.pick_base_dataset(datasets, request.base_dataset_id)
        rag_context = build_semantic_rag_context(
            db=self.catalog_repository.db,
            settings=settings,
            actor=actor_context,
            query=prompt,
            dataset_ids=context_dataset_ids,
            semantic_model_id=request.semantic_model_id,
        )
        request_id = str(uuid4())
        context_token = issue_ai_context_token(
            request_id=request_id,
            actor=actor_context,
            allowed_dataset_ids=context_dataset_ids,
            dataset_permissions={dataset.id: ["query"] for dataset in datasets},
        )
        raw_suggestion = AiGatewayClient().generate_query_sql(
            request_id=request_id,
            prompt=prompt,
            current_query=request.current_query or "",
            base_dataset_id=base_dataset.id,
            selected_dataset_ids=context_dataset_ids,
            context_token=context_token,
            rag_context=rag_context,
        )

        suggestion = raw_suggestion if isinstance(raw_suggestion, dict) else parse_ai_suggestion(raw_suggestion)
        sql = ensure_preview_limit(suggestion.get("sql", ""))
        statement = validate_read_only_query(sql)
        validate_selected_dataset_scope(statement, datasets)
        used_evidence_ids = [str(item) for item in suggestion.get("usedEvidenceIds") or []]
        used_rag_context = retain_used_rag_evidence(rag_context, used_evidence_ids) or {
            "sources": [],
            "retrieval": None,
        }

        return QueryAiSuggestionResponse(
            body=suggestion.get("body")
            or "Read-only SQL draft generated from the selected dataset context.",
            model=(str(raw_suggestion.get("model")) if isinstance(raw_suggestion, dict) and raw_suggestion.get("model") else None),
            provider=(str(raw_suggestion.get("provider")) if isinstance(raw_suggestion, dict) and raw_suggestion.get("provider") else None),
            notices=normalize_notices(suggestion.get("notices")),
            retrieval=used_rag_context.get("retrieval"),
            sources=list(used_rag_context.get("sources") or []),
            sql=sql,
            title=suggestion.get("title") or "SQL draft",
            used_evidence_ids=used_evidence_ids,
        )

    def get_catalog_dataset(self, dataset_id: str) -> CatalogDatasetResponse:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "Dataset not found",
                status.HTTP_404_NOT_FOUND,
                {"datasetId": dataset_id},
            )
        return dataset_with_persisted_permission_grants(
            self.catalog_repository.db,
            CatalogDatasetResponse.model_validate(payload),
        )

    def pick_base_dataset(
        self,
        datasets: list[CatalogDatasetResponse],
        base_dataset_id: str | None,
    ) -> CatalogDatasetResponse:
        if base_dataset_id:
            for dataset in datasets:
                if dataset.id == base_dataset_id:
                    return dataset
        return datasets[0]


def ensure_preview_limit(sql: str) -> str:
    cleaned_sql = sql.strip()
    if not cleaned_sql:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "AI did not return SQL",
            status.HTTP_502_BAD_GATEWAY,
        )

    statement = validate_read_only_query(cleaned_sql)
    try:
        expression = parse_one(statement, read="trino")
    except ParseError as exc:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "AI returned SQL that could not be parsed",
            status.HTTP_502_BAD_GATEWAY,
        ) from exc

    root_limit = expression.args.get("limit")
    if isinstance(root_limit, exp.Limit):
        limit_expression = root_limit.expression
        if isinstance(limit_expression, exp.Literal) and limit_expression.is_int:
            if int(limit_expression.this) <= PREVIEW_LIMIT:
                return cleaned_sql

    bounded = expression.limit(PREVIEW_LIMIT, copy=True)
    return f"{bounded.sql(dialect='trino')};"


def validate_selected_dataset_scope(
    statement: str,
    datasets: list[CatalogDatasetResponse],
) -> None:
    dataset_by_table_name = build_dataset_context_map(datasets)
    referenced_table_names = extract_referenced_table_names(statement)
    cte_names = extract_cte_names(statement)
    physical_table_names = [
        table_name
        for table_name in referenced_table_names
        if table_name not in cte_names
    ]
    if not physical_table_names:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "AI SQL must reference at least one selected dataset",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    unknown_table_names = [
        table_name
        for table_name in physical_table_names
        if table_name not in dataset_by_table_name
    ]
    if unknown_table_names:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "AI SQL references tables outside the selected dataset context",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"tables": unknown_table_names},
        )


def normalize_notices(value: object) -> list[str]:
    if not isinstance(value, list):
        return [
            "AI generated this draft. Review it before running the existing checks.",
        ]
    return [str(item) for item in value if str(item).strip()]
