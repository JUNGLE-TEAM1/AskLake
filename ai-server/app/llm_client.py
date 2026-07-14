import json
from typing import Any, Protocol

import httpx

from .config import Settings
from .schemas import GenerateRequest, QuerySqlOutput
from .mcp_client import McpContextClient


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

    async def generate(self, request: GenerateRequest) -> QuerySqlOutput:
        ...

    async def close(self) -> None:
        ...


class MockLLMClient:
    provider_name = "mock"
    model_name = "mock-query-sql"

    async def generate(self, request: GenerateRequest) -> QuerySqlOutput:
        datasets = request.context.get("datasets") if isinstance(request.context, dict) else None
        table_name = None
        if isinstance(datasets, list) and datasets:
            first_dataset = datasets[0]
            if isinstance(first_dataset, dict):
                table_name = first_dataset.get("dataset_name") or first_dataset.get("datasetName")
        query_sql = f"SELECT * FROM {table_name} LIMIT 100;" if table_name else "SELECT 1 AS mock_result;"
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

        return parse_chat_completion(payload)

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
    return {
        "model": settings.provider_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Return only a JSON object matching the supplied query_sql schema. "
                    "Produce a read-only SQL draft; do not execute SQL or tools."
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
                "name": "query_sql_output",
                "strict": True,
                "schema": QuerySqlOutput.model_json_schema(),
            },
        },
    }


def parse_chat_completion(payload: Any) -> QuerySqlOutput:
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
        return QuerySqlOutput.model_validate(decoded)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ProviderResponseError("Provider output did not match the query_sql contract") from exc


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
