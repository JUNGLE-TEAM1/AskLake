import json
import urllib.error
import urllib.request
from typing import Any

from fastapi import status

from app.core.config import settings
from app.core.errors import ApiError
from app.schemas.ai_generation import AiSqlGenerationRequest, AiSqlGenerationResponse
from app.schemas.common import ErrorCode


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


class AiGenerationService:
    def generate_sql(self, request: AiSqlGenerationRequest) -> AiSqlGenerationResponse:
        if not settings.openai_api_key:
            raise ApiError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "OPENAI_API_KEY is not configured",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        payload = {
            "input": [
                {"role": "system", "content": self._system_prompt(request)},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "question": request.question.strip(),
                            "promptType": request.prompt_type,
                            "metadata": request.metadata,
                            "context": request.context or "",
                            "engine": request.engine,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            "max_output_tokens": 500,
            "model": settings.openai_query_ai_model,
            "store": False,
            "temperature": 0.1,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "asklake_sql_generation",
                    "description": "A safe SQL expression or SELECT transformation for AskLake ETL.",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "sql": {"type": "string"},
                            "schema_context": {"type": "string"},
                        },
                        "required": ["sql", "schema_context"],
                    },
                },
            },
        }
        http_request = urllib.request.Request(
            OPENAI_RESPONSES_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {settings.openai_api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                http_request,
                timeout=settings.openai_assistant_timeout_seconds,
            ) as response:
                raw_payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OpenAI SQL generation request failed",
                status.HTTP_502_BAD_GATEWAY,
                {"status": exc.code},
            ) from exc
        except (TimeoutError, urllib.error.URLError) as exc:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "OpenAI SQL generation request timed out",
                status.HTTP_504_GATEWAY_TIMEOUT,
            ) from exc

        result = self._extract_result(raw_payload)
        sql = str(result.get("sql") or "").strip()
        if not sql:
            raise ApiError(
                ErrorCode.SQL_SYNTAX_ERROR,
                "OpenAI did not return a SQL suggestion",
                status.HTTP_502_BAD_GATEWAY,
            )
        return AiSqlGenerationResponse(
            sql=sql,
            schema_context=str(result.get("schema_context") or ""),
            model=settings.openai_query_ai_model,
        )

    @staticmethod
    def _system_prompt(request: AiSqlGenerationRequest) -> str:
        if request.prompt_type == "sql_transform":
            output_shape = "Return a read-only Spark SQL SELECT statement whose input relation is named input."
        elif request.prompt_type == "field_transform":
            output_shape = "Return only a scalar SQL expression for the original column; do not return SELECT or a code fence."
        else:
            output_shape = "Return the smallest safe SQL expression or SELECT statement that satisfies the request."
        return "\n".join(
            [
                "You are Nessie, AskLake's ETL SQL transformation assistant.",
                output_shape,
                "Use only columns present in metadata. Never mutate data, use DDL, or invent external tables.",
                "Preserve the requested engine's syntax and return JSON only.",
            ]
        )

    @staticmethod
    def _extract_result(payload: dict[str, Any]) -> dict[str, Any]:
        output_text = payload.get("output_text")
        if not isinstance(output_text, str) or not output_text.strip():
            parts: list[str] = []
            for output_item in payload.get("output", []):
                if not isinstance(output_item, dict):
                    continue
                for content_item in output_item.get("content", []):
                    if isinstance(content_item, dict) and isinstance(content_item.get("text"), str):
                        parts.append(content_item["text"])
            output_text = "\n".join(parts).strip()
        try:
            result = json.loads(output_text)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OpenAI response was not valid SQL JSON",
                status.HTTP_502_BAD_GATEWAY,
            ) from exc
        if not isinstance(result, dict):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "OpenAI SQL response must be an object",
                status.HTTP_502_BAD_GATEWAY,
            )
        return result
