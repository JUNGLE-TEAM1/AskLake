import json
import re
import urllib.error
import urllib.request
from typing import Any

from fastapi import status

from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryAiSuggestionRequest, QueryAiSuggestionResponse
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.services.sql_service import (
    build_dataset_context_map,
    extract_cte_names,
    extract_referenced_table_names,
    unique_dataset_ids,
    validate_read_only_query,
)

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
PREVIEW_LIMIT = 100
QUERY_AI_SAMPLE_ROW_LIMIT = 5


class QueryAiService:
    def __init__(self, catalog_repository: CatalogRepository) -> None:
        self.catalog_repository = catalog_repository

    def create_suggestion(
        self,
        request: QueryAiSuggestionRequest,
        actor: ActorContext | None = None,
        *,
        api_path: str = "/api/query/ai-suggestions",
        resolved_datasets: list[CatalogDatasetResponse] | None = None,
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

        datasets = resolved_datasets or self.resolve_context_datasets(
            context_dataset_ids,
            actor_context,
            api_path=api_path,
        )
        if [dataset.id for dataset in datasets] != context_dataset_ids:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Resolved dataset context does not match the request",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        base_dataset = self.pick_base_dataset(datasets, request.base_dataset_id)
        client = OpenAiResponsesClient(
            api_key=settings.openai_api_key,
            model=settings.openai_query_ai_model,
        )
        raw_suggestion = client.create_json_response(
            system_prompt=build_system_prompt(),
            user_payload=build_user_payload(
                base_dataset=base_dataset,
                current_query=request.current_query or "",
                datasets=datasets,
                prompt=prompt,
            ),
        )

        suggestion = parse_ai_suggestion(raw_suggestion)
        sql = ensure_preview_limit(suggestion.get("sql", ""))
        statement = validate_read_only_query(sql)
        validate_selected_dataset_scope(statement, datasets)

        return QueryAiSuggestionResponse(
            body=suggestion.get("body")
            or "Read-only SQL draft generated from the selected dataset context.",
            model=settings.openai_query_ai_model,
            notices=normalize_notices(suggestion.get("notices")),
            sql=sql,
            title=suggestion.get("title") or "SQL draft",
        )

    def resolve_context_datasets(
        self,
        dataset_ids: list[str],
        actor: ActorContext,
        *,
        api_path: str = "/api/query/ai-suggestions",
        http_method: str = "POST",
    ) -> list[CatalogDatasetResponse]:
        datasets = [self.get_catalog_dataset(dataset_id) for dataset_id in dataset_ids]
        for dataset in datasets:
            if dataset.status != "available":
                raise ApiError(
                    ErrorCode.VALIDATION_ERROR,
                    "Dataset is not available for AI context",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"datasetId": dataset.id, "status": dataset.status},
                )
            require_governed_access(
                self.catalog_repository.db,
                actor,
                action="query",
                api_path=api_path,
                http_method=http_method,
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


class OpenAiResponsesClient:
    def __init__(self, api_key: str | None, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def create_json_response(
        self,
        *,
        system_prompt: str,
        user_payload: dict[str, Any],
    ) -> str:
        if not self.api_key:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OPENAI_API_KEY is not configured",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        request_body = {
            "input": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps(
                        user_payload,
                        ensure_ascii=False,
                    ),
                },
            ],
            "max_output_tokens": 900,
            "model": self.model,
            "store": False,
            "temperature": 0.2,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "query_ai_suggestion",
                    "description": "A safe read-only SQL suggestion for the selected AskLake datasets.",
                    "schema": query_ai_response_schema(),
                },
            },
        }
        request = urllib.request.Request(
            OPENAI_RESPONSES_URL,
            data=json.dumps(request_body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            details = read_openai_error(exc)
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OpenAI query suggestion request failed",
                status.HTTP_502_BAD_GATEWAY,
                details,
            ) from exc
        except (TimeoutError, urllib.error.URLError) as exc:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "OpenAI query suggestion request timed out",
                status.HTTP_504_GATEWAY_TIMEOUT,
            ) from exc

        return extract_response_text(payload)


def build_system_prompt() -> str:
    return "\n".join(
        [
            "You are AskLake Query AI.",
            "Create one read-only SQL draft from the user's natural language request.",
            "Use only the selected dataset table names exactly as provided.",
            "Prefer current non-legacy datasets. Do not use a dataset whose name or tags indicate legacy unless it is the only selected dataset.",
            "Do not silently ignore requested filters, dimensions, or business qualifiers.",
            "If the request mentions a qualifier such as VIP, region, channel, product category, payment method, status, or date range, include the matching WHERE, GROUP BY, or JOIN logic when selected schemas contain matching columns.",
            "Generate JOIN or multi-table SQL when the selected datasets and joinHints contain the needed tables and keys.",
            "When using joins, keep every physical table reference inside the selected dataset context.",
            "If a requested JOIN key is unclear, still return a safe exploratory SQL draft but put a notice starting with 'JOIN 확인 필요:'.",
            "If the selected datasets cannot satisfy an important part of the user request, still return a safe exploratory SQL draft but put a notice starting with '필요한 데이터셋/컬럼 누락:'.",
            "Allowed SQL starts with SELECT or WITH and must not mutate data.",
            f"Always keep the preview bounded with LIMIT {PREVIEW_LIMIT}.",
            "Return JSON only with keys: title, body, sql, notices.",
            "notices must be a short string array.",
        ]
    )


def build_user_payload(
    *,
    base_dataset: CatalogDatasetResponse,
    current_query: str,
    datasets: list[CatalogDatasetResponse],
    prompt: str,
) -> dict[str, Any]:
    return {
        "baseDatasetId": base_dataset.id,
        "currentQuery": current_query,
        "joinHints": build_join_hints(datasets),
        "naturalLanguageRequest": prompt,
        "previewLimit": PREVIEW_LIMIT,
        "selectedDatasets": [
            {
                "description": dataset.description,
                "id": dataset.id,
                "layer": dataset.layer,
                "name": dataset.name,
                "sampleRows": dataset.sample_rows[:QUERY_AI_SAMPLE_ROW_LIMIT],
                "schema": [
                    {"name": column_name, "type": column_type}
                    for column_name, column_type in dataset.schema_
                ],
                "tags": dataset.tags,
                "upstream": dataset.upstream,
            }
            for dataset in datasets
        ],
    }


def build_join_hints(
    datasets: list[CatalogDatasetResponse],
) -> list[dict[str, str]]:
    join_hints: list[dict[str, str]] = []

    for left_index, left_dataset in enumerate(datasets):
        left_columns = {column_name for column_name, _ in left_dataset.schema_}
        for right_dataset in datasets[left_index + 1:]:
            right_columns = {column_name for column_name, _ in right_dataset.schema_}
            shared_columns = sorted(left_columns & right_columns)
            for column_name in shared_columns:
                if not is_likely_join_key(column_name):
                    continue
                join_hints.append({
                    "leftColumn": column_name,
                    "leftTable": left_dataset.name,
                    "rightColumn": column_name,
                    "rightTable": right_dataset.name,
                })

    return join_hints


def is_likely_join_key(column_name: str) -> bool:
    normalized_column = column_name.lower()
    return normalized_column == "id" or normalized_column.endswith("_id")


def parse_ai_suggestion(raw_text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(strip_json_fence(raw_text))
    except json.JSONDecodeError as exc:
        json_candidate = extract_json_object(raw_text)
        if json_candidate is None:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OpenAI response was not valid JSON",
                status.HTTP_502_BAD_GATEWAY,
            ) from exc
        try:
            parsed = json.loads(json_candidate)
        except json.JSONDecodeError as candidate_exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OpenAI response was not valid JSON",
                status.HTTP_502_BAD_GATEWAY,
            ) from candidate_exc

    if not isinstance(parsed, dict):
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "OpenAI response JSON must be an object",
            status.HTTP_502_BAD_GATEWAY,
        )

    return parsed


def ensure_preview_limit(sql: str) -> str:
    cleaned_sql = sql.strip()
    if not cleaned_sql:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "AI did not return SQL",
            status.HTTP_502_BAD_GATEWAY,
        )

    trailing_limit_match = re.search(r"\blimit\s+(\d+)\s*;?\s*$", cleaned_sql, re.IGNORECASE)
    if trailing_limit_match:
        limit_value = int(trailing_limit_match.group(1))
        if limit_value <= PREVIEW_LIMIT:
            return cleaned_sql
        return f"{cleaned_sql[:trailing_limit_match.start()].rstrip().rstrip(';')}\nLIMIT {PREVIEW_LIMIT};"

    if re.search(r"\blimit\s+\d+\b", cleaned_sql, re.IGNORECASE):
        return cleaned_sql

    return f"{cleaned_sql.rstrip(';')}\nLIMIT {PREVIEW_LIMIT};"


def query_ai_response_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "title": {"type": "string"},
            "body": {"type": "string"},
            "sql": {"type": "string"},
            "notices": {
                "type": "array",
                "items": {"type": "string"},
            },
        },
        "required": ["title", "body", "sql", "notices"],
    }


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


def extract_response_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    text_parts: list[str] = []
    for output_item in payload.get("output", []):
        if not isinstance(output_item, dict):
            continue
        for content_item in output_item.get("content", []):
            if not isinstance(content_item, dict):
                continue
            text = content_item.get("text")
            if isinstance(text, str):
                text_parts.append(text)

    text = "\n".join(text_parts).strip()
    if not text:
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "OpenAI response did not include text output",
            status.HTTP_502_BAD_GATEWAY,
        )
    return text


def strip_json_fence(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def extract_json_object(value: str) -> str | None:
    start = value.find("{")
    end = value.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return value[start : end + 1]


def read_openai_error(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"status": exc.code}

    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return {"status": exc.code}

    return {
        "openaiCode": error.get("code"),
        "openaiType": error.get("type"),
        "status": exc.code,
    }
