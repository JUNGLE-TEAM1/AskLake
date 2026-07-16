import json
import re
from typing import Any, Protocol

import httpx

from .config import Settings
from .schemas import DatasetClassificationOutput, DocumentSegmentationOutput, GenerateRequest, GenerationOutput, QuerySqlOutput
from .mcp_client import McpContextClient


def quote_sql_identifier(value: str) -> str:
    """Quote a SQL identifier without changing its logical Dataset name."""
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        return value
    return '"' + value.replace('"', '""') + '"'


class ProviderError(Exception):
    """Base class for safe, non-secret provider failures."""


class ProviderConfigurationError(ProviderError):
    pass


class ProviderTimeoutError(ProviderError):
    pass


class ProviderUnavailableError(ProviderError):
    pass


class ProviderResponseError(ProviderError):
    pass


class LLMClient(Protocol):
    provider_name: str
    model_name: str

    async def generate(self, request: GenerateRequest) -> GenerationOutput:
        ...

    async def close(self) -> None:
        ...


class MockLLMClient:
    provider_name = "mock"
    model_name = "mock-query-sql"

    async def generate(self, request: GenerateRequest) -> GenerationOutput:
        if request.mode == "classify_dataset":
            schema = request.context.get("schema") if isinstance(request.context, dict) else []
            roles = []
            for column in schema if isinstance(schema, list) else []:
                name = str(column.get("name") if isinstance(column, dict) else column)
                lowered = name.casefold()
                role = "body" if any(token in lowered for token in ("review", "comment", "text", "content", "message", "description", "body")) else "title" if any(token in lowered for token in ("title", "subject", "headline", "name")) else "identifier" if lowered.endswith("_id") else "metadata" if any(token in lowered for token in ("rating", "score", "sentiment", "category", "status", "date", "region", "product")) else "excluded"
                roles.append({"columnName": name, "role": role, "confidence": 0.6, "reason": "Local deterministic classifier recommendation"})
            return DatasetClassificationOutput(classification="review" if any(item["role"] == "body" for item in roles) else "generic_text", confidence=0.6, roles=roles)
        if request.mode == "segment_document":
            context = request.context if isinstance(request.context, dict) else {}
            sentences = context.get("sentences") if isinstance(context.get("sentences"), list) else []
            candidate_boundaries = context.get("candidateBoundaries") if isinstance(context.get("candidateBoundaries"), list) else []
            sentence_count = len(sentences)
            boundaries = sorted({int(value) for value in candidate_boundaries if isinstance(value, (int, float)) and int(value) >= 0})
            segments = []
            start = 0
            for boundary in boundaries:
                if start >= sentence_count:
                    break
                end = min(boundary, sentence_count - 1)
                if end >= start:
                    segments.append({"startSentence": start, "endSentence": end})
                    start = end + 1
            if start < sentence_count:
                segments.append({"startSentence": start, "endSentence": sentence_count - 1})
            if not segments and sentence_count:
                segments = [{"startSentence": 0, "endSentence": sentence_count - 1}]
            return DocumentSegmentationOutput(segments=segments, confidence=0.6)
        datasets = request.context.get("datasets") if isinstance(request.context, dict) else None
        table_name = None
        if isinstance(datasets, list) and datasets:
            first_dataset = datasets[0]
            if isinstance(first_dataset, dict):
                table_name = first_dataset.get("dataset_name") or first_dataset.get("datasetName")
        query_sql = f"SELECT * FROM {quote_sql_identifier(str(table_name))} LIMIT 100;" if table_name else "SELECT 1 AS mock_result;"
        return QuerySqlOutput(
            query_sql=query_sql,
            explanation="Deterministic mock provider output for local development and tests.",
            warnings=["Mock provider is enabled; this SQL is not model-generated."],
        )

    async def close(self) -> None:
        return None


class OpenAICompatibleClient:
    provider_name = "openai_compatible"

    def __init__(self, settings: Settings, http_client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self.model_name = settings.provider_model
        self._owns_http_client = http_client is None
        self._http_client = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(settings.request_timeout_seconds),
            follow_redirects=False,
        )

    async def generate(self, request: GenerateRequest) -> QuerySqlOutput:
        api_key = self.settings.provider_api_key
        if api_key is None or not api_key.get_secret_value():
            raise ProviderConfigurationError("Provider API key is not configured")

        body = build_chat_completion_request(self.settings, request)
        headers = {
            "Authorization": f"Bearer {api_key.get_secret_value()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        url = f"{self.settings.provider_base_url}/chat/completions"

        try:
            async with self._http_client.stream("POST", url, headers=headers, json=body) as response:
                raw_payload = await read_bounded_body(response, self.settings.max_provider_response_bytes)
                if response.status_code >= 400:
                    raise ProviderResponseError("Provider returned an error response")
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("Provider request timed out") from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError("Provider request failed") from exc

        try:
            payload = json.loads(raw_payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderResponseError("Provider returned invalid JSON") from exc

        return parse_chat_completion(payload, request.mode)

    async def close(self) -> None:
        if self._owns_http_client:
            await self._http_client.aclose()


async def read_bounded_body(response: httpx.Response, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > max_bytes:
            raise ProviderResponseError("Provider response exceeded the configured size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def build_chat_completion_request(settings: Settings, request: GenerateRequest) -> dict[str, Any]:
    user_payload = {
        "prompt": request.prompt,
        "current_query": request.current_query,
        "context": request.context,
        "tools": request.tools,
        "base_dataset_id": request.base_dataset_id,
        "selected_dataset_ids": request.selected_dataset_ids,
    }
    output_schema = {
        "query_sql": QuerySqlOutput,
        "classify_dataset": DatasetClassificationOutput,
        "segment_document": DocumentSegmentationOutput,
    }[request.mode]
    output_name = {
        "query_sql": "query_sql_output",
        "classify_dataset": "dataset_classification_output",
        "segment_document": "document_segmentation_output",
    }[request.mode]
    return {
        "model": settings.provider_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Return only a JSON object matching the supplied output schema. "
                    "For query_sql mode, produce a read-only SQL draft; do not execute SQL or tools. When context.ragContext.provenance is semantic_layer_rag, use its source chunks as evidence. "
                    "For classify_dataset mode, assign one role to each supplied schema column. "
                    "For segment_document mode, return only contiguous inclusive sentence ranges; never rewrite or omit text."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(user_payload, ensure_ascii=False, separators=(",", ":")),
            },
        ],
        "temperature": 0,
        "max_tokens": settings.max_output_tokens,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                    "name": output_name,
                    "strict": True,
                    "schema": output_schema.model_json_schema(),
            },
        },
    }


def parse_chat_completion(payload: Any, mode: str = "query_sql") -> GenerationOutput:
    if not isinstance(payload, dict):
        raise ProviderResponseError("Provider returned an unexpected response shape")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ProviderResponseError("Provider response did not include a choice")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ProviderResponseError("Provider response did not include a message")
    content = extract_message_content(message.get("content"))
    try:
        decoded = json.loads(strip_json_fence(content))
        output_schema = {
            "query_sql": QuerySqlOutput,
            "classify_dataset": DatasetClassificationOutput,
            "segment_document": DocumentSegmentationOutput,
        }.get(mode)
        if output_schema is None:
            raise ProviderResponseError("Provider output mode is unsupported")
        return output_schema.model_validate(decoded)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ProviderResponseError(f"Provider output did not match the {mode} contract") from exc


def extract_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [item.get("text", "") for item in content if isinstance(item, dict)]
        if all(isinstance(part, str) for part in text_parts):
            return "".join(text_parts)
    raise ProviderResponseError("Provider message did not include text content")


def strip_json_fence(value: str) -> str:
    text = value.strip()
    if text.startswith("```") and text.endswith("```"):
        first_line, _, remainder = text.partition("\n")
        if first_line.strip().casefold() in {"```", "```json"}:
            return remainder[:-3].strip()
    return text


def create_llm_client(settings: Settings) -> LLMClient:
    if settings.provider == "mock":
        return MockLLMClient()
    return OpenAICompatibleClient(settings)
