import re
from typing import Any
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
from app.services.ai_generation_audit import (
    evidence_candidate_ids,
    persist_verified_generation_evidence,
    verified_used_evidence_ids,
)
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
        prompt, context_dataset_ids = self._validated_context(request)
        datasets = self._authorized_datasets(context_dataset_ids, actor_context)
        base_dataset = self.pick_base_dataset(datasets, request.base_dataset_id)
        request_id, rag_context, raw_suggestion = self._generate_suggestion(
            request,
            actor_context,
            prompt,
            context_dataset_ids,
            datasets,
            base_dataset,
        )
        return self._verified_response(
            request=request,
            actor=actor_context,
            prompt=prompt,
            context_dataset_ids=context_dataset_ids,
            datasets=datasets,
            base_dataset=base_dataset,
            request_id=request_id,
            rag_context=rag_context,
            raw_suggestion=raw_suggestion,
        )

    @staticmethod
    def _validated_context(request: QueryAiSuggestionRequest) -> tuple[str, list[str]]:
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
        return prompt, context_dataset_ids

    def _authorized_datasets(
        self,
        context_dataset_ids: list[str],
        actor: ActorContext,
    ) -> list[CatalogDatasetResponse]:
        datasets = [
            self.get_catalog_dataset(dataset_id)
            for dataset_id in context_dataset_ids
        ]
        for dataset in datasets:
            require_governed_access(
                self.catalog_repository.db,
                actor,
                action="query",
                api_path="/api/query/ai-suggestions",
                http_method="POST",
                metadata={"owner": dataset.owner},
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
        return datasets

    def _generate_suggestion(
        self,
        request: QueryAiSuggestionRequest,
        actor: ActorContext,
        prompt: str,
        context_dataset_ids: list[str],
        datasets: list[CatalogDatasetResponse],
        base_dataset: CatalogDatasetResponse,
    ) -> tuple[str, dict[str, Any], dict[str, object]]:
        rag_context = build_semantic_rag_context(
            db=self.catalog_repository.db,
            settings=settings,
            actor=actor,
            query=prompt,
            dataset_ids=context_dataset_ids,
            semantic_model_id=request.semantic_model_id,
        )
        generation_prompt = _build_query_generation_prompt(prompt, datasets)
        for attempt in range(2):
            request_id = str(uuid4())
            context_token = issue_ai_context_token(
                request_id=request_id,
                actor=actor,
                allowed_dataset_ids=context_dataset_ids,
                dataset_permissions={dataset.id: ["query"] for dataset in datasets},
            )
            raw_suggestion = AiGatewayClient().generate_query_sql(
                request_id=request_id,
                prompt=generation_prompt,
                current_query=request.current_query or "",
                base_dataset_id=base_dataset.id,
                selected_dataset_ids=context_dataset_ids,
                context_token=context_token,
                rag_context=rag_context,
            )
            if not isinstance(raw_suggestion, dict):
                raise ApiError(
                    ErrorCode.INTERNAL_ERROR,
                    "AI gateway returned an invalid SQL suggestion",
                    status.HTTP_502_BAD_GATEWAY,
                )

            sql = ensure_preview_limit(raw_suggestion.get("sql", ""))
            statement = validate_read_only_query(sql)
            validate_selected_dataset_scope(statement, datasets)
            try:
                validate_query_intent_contract(prompt, statement, datasets)
            except ApiError as exc:
                violations = list((exc.details or {}).get("violations") or [])
                if attempt > 0 or not violations:
                    raise
                generation_prompt = _build_query_generation_prompt(
                    prompt,
                    datasets,
                    failed_violations=violations,
                )
                continue
            return request_id, rag_context, raw_suggestion

        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "AI gateway did not return a verified SQL suggestion",
            status.HTTP_502_BAD_GATEWAY,
        )

    def _verified_response(
        self,
        *,
        request: QueryAiSuggestionRequest,
        actor: ActorContext,
        prompt: str,
        context_dataset_ids: list[str],
        datasets: list[CatalogDatasetResponse],
        base_dataset: CatalogDatasetResponse,
        request_id: str,
        rag_context: dict[str, Any],
        raw_suggestion: dict[str, object],
    ) -> QueryAiSuggestionResponse:
        if not isinstance(raw_suggestion, dict):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned an invalid SQL suggestion",
                status.HTTP_502_BAD_GATEWAY,
            )
        suggestion = raw_suggestion
        sql = ensure_preview_limit(suggestion.get("sql", ""))
        statement = validate_read_only_query(sql)
        validate_selected_dataset_scope(statement, datasets)
        validate_query_intent_contract(prompt, statement, datasets)
        used_evidence_ids = [str(item) for item in suggestion.get("usedEvidenceIds") or []]
        used_rag_context = retain_used_rag_evidence(rag_context, used_evidence_ids) or {
            "sources": [],
            "retrieval": None,
        }
        verified_evidence_ids = verified_used_evidence_ids(used_rag_context)
        provider = str(raw_suggestion.get("provider") or "").strip()
        model = str(raw_suggestion.get("model") or "").strip()
        persist_verified_generation_evidence(
            self.catalog_repository.db,
            actor=actor,
            candidate_ids=evidence_candidate_ids(rag_context),
            context_payload={
                "baseDatasetId": base_dataset.id,
                "currentQuery": request.current_query or "",
                "prompt": prompt,
                "selectedDatasetIds": context_dataset_ids,
                "semanticModelId": request.semantic_model_id,
            },
            mode="query_sql",
            model=model,
            output_payload={"sql": sql},
            provider=provider,
            request_id=request_id,
            used_ids=verified_evidence_ids,
        )

        return QueryAiSuggestionResponse(
            body=suggestion.get("body")
            or "Read-only SQL draft generated from the selected dataset context.",
            model=model,
            provider=provider,
            request_id=request_id,
            notices=normalize_notices(suggestion.get("notices")),
            retrieval=used_rag_context.get("retrieval"),
            sources=list(used_rag_context.get("sources") or []),
            sql=sql,
            title=suggestion.get("title") or "SQL draft",
            used_evidence_ids=verified_evidence_ids,
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


def validate_query_intent_contract(
    prompt: str,
    statement: str,
    datasets: list[CatalogDatasetResponse],
) -> None:
    """Reject SQL drafts that visibly contradict explicit analytical intent."""

    try:
        expression = parse_one(statement, read="trino")
    except ParseError as exc:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "AI returned SQL that could not be parsed",
            status.HTTP_502_BAD_GATEWAY,
        ) from exc

    normalized_prompt = prompt.casefold()
    violations: list[str] = []
    if re.search(r"평균|\baverage\b|\bavg\b", normalized_prompt) and not any(
        expression.find_all(exp.Avg)
    ):
        violations.append("missing_average")
    if re.search(
        r"상품\s*(?:수|개수)|제품\s*(?:수|개수)|건수|개수|\bnumber\s+of\b|\bcount\s+of\b",
        normalized_prompt,
    ) and not any(expression.find_all(exp.Count)):
        violations.append("missing_count")
    if re.search(r"[0-9a-z가-힣_]+\s*별(?:로)?|\bby\s+[a-z_]", normalized_prompt) and not any(
        expression.find_all(exp.Group)
    ):
        violations.append("missing_grouping")
    if _uses_dataset_qualifier_as_row_filter(normalized_prompt, expression, datasets):
        violations.append("dataset_qualifier_filter")

    if violations:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "AI SQL did not satisfy the requested analysis intent",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"violations": violations},
        )


def _uses_dataset_qualifier_as_row_filter(
    normalized_prompt: str,
    expression: exp.Expression,
    datasets: list[CatalogDatasetResponse],
) -> bool:
    explicit_filter_markers = (
        "where",
        "like",
        "필터",
        "조건",
        "제목",
        "타이틀",
        "title",
        "이름",
        "name",
        "포함",
        "일치",
        "검색",
        "찾아",
    )
    if any(marker in normalized_prompt for marker in explicit_filter_markers):
        return False

    filter_literals = " ".join(
        str(literal.this).casefold()
        for clause in expression.find_all(exp.Where, exp.Having)
        for literal in clause.find_all(exp.Literal)
        if literal.is_string
    )
    if not filter_literals:
        return False

    return any(
        token in normalized_prompt and token in filter_literals
        for token in _dataset_qualifier_tokens(datasets)
    )


def _dataset_qualifier_tokens(datasets: list[CatalogDatasetResponse]) -> set[str]:
    generic_tokens = {
        "catalog",
        "data",
        "dataset",
        "gold",
        "product",
        "products",
        "table",
    }
    tokens: set[str] = set()
    for dataset in datasets:
        metadata_values = (
            dataset.id,
            dataset.name,
            dataset.source,
            dataset.description,
            *dataset.tags,
        )
        for value in metadata_values:
            tokens.update(
                token
                for token in re.findall(r"[0-9a-z가-힣]+", str(value).casefold())
                if len(token) >= 3 and token not in generic_tokens
            )
    return tokens


def _build_query_generation_prompt(
    prompt: str,
    datasets: list[CatalogDatasetResponse],
    *,
    failed_violations: list[str] | None = None,
) -> str:
    dataset_labels = ", ".join(
        f"{dataset.id} ({dataset.name}; source={dataset.source})"
        for dataset in datasets
    )
    lines = [
        prompt,
        "",
        "SQL 생성 계약:",
        f"- 선택 데이터셋: {dataset_labels}",
        "- 데이터셋명·출처명은 사용자가 열 조건을 명시하지 않은 한 행 필터 값이 아닙니다.",
        "- 요청한 집계(평균·개수)와 그룹 기준을 SQL에 빠짐없이 반영하세요.",
        "- 선택 데이터셋만 참조하는 읽기 전용 SQL 한 개를 반환하세요.",
    ]
    if failed_violations:
        lines.extend((
            "",
            f"이전 SQL 검증 실패: {', '.join(failed_violations)}",
            "검증 실패 항목을 모두 고쳐 SQL을 다시 생성하세요.",
        ))
    return "\n".join(lines)


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
