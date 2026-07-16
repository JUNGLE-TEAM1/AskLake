from typing import Any
from urllib.parse import urljoin

import httpx
from fastapi import status

from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.schemas.ai import (
    AiGatewayProviderResponse,
    AiGatewayQueryRequest,
    AiGatewayQueryResponse,
)
from app.schemas.common import ErrorCode


class AiGatewayClient:
    """Synchronous client for the private internal AI server."""

    def __init__(self, runtime_settings: Settings | None = None) -> None:
        self.settings = runtime_settings or settings

    def generate_query_sql(
        self,
        request_id: str,
        prompt: str,
        current_query: str,
        base_dataset_id: str | None,
        selected_dataset_ids: list[str],
        context_token: str,
        rag_context: dict[str, Any] | None = None,
    ) -> dict[str, object]:
        request = AiGatewayQueryRequest(
            request_id=request_id,
            prompt=prompt,
            current_query=current_query,
            base_dataset_id=base_dataset_id,
            selected_dataset_ids=selected_dataset_ids,
            rag_context=rag_context or {},
        )
        if not isinstance(context_token, str) or not context_token.strip():
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "AI context token is required",
                status.HTTP_401_UNAUTHORIZED,
            )
        if not self.settings.ai_gateway_base_url or not self.settings.ai_gateway_service_token:
            raise ApiError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "AI gateway is not configured",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        endpoint = urljoin(
            f"{self.settings.ai_gateway_base_url.rstrip('/')}/",
            self.settings.ai_gateway_generate_path.lstrip("/"),
        )
        try:
            response = httpx.post(
                endpoint,
                json=request.model_dump(mode="json"),
                headers={
                    "Authorization": f"Bearer {self.settings.ai_gateway_service_token}",
                    "Content-Type": "application/json",
                    "X-AskLake-AI-Context": context_token,
                    "X-Request-ID": request.request_id,
                },
                timeout=self.settings.ai_gateway_timeout_seconds,
            )
        except httpx.TimeoutException as exc:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "AI gateway request timed out",
                status.HTTP_504_GATEWAY_TIMEOUT,
            ) from exc
        except httpx.RequestError as exc:
            raise ApiError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "AI gateway is unavailable",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from exc

        if response.status_code in {401, 403}:
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "AI gateway authentication failed",
                status.HTTP_401_UNAUTHORIZED,
            )
        if response.status_code == 502:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned a bad gateway response",
                status.HTTP_502_BAD_GATEWAY,
            )
        if response.status_code == 503:
            raise ApiError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "AI gateway is temporarily unavailable",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if response.status_code >= 500:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway request failed",
                status.HTTP_502_BAD_GATEWAY,
            )
        if response.status_code >= 400:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway rejected the request",
                status.HTTP_502_BAD_GATEWAY,
            )

        try:
            payload = response.json()
            try:
                result = AiGatewayQueryResponse.model_validate(payload)
            except (ValueError, TypeError):
                provider_response = AiGatewayProviderResponse.model_validate(payload)
                result = AiGatewayQueryResponse(
                    title="SQL draft",
                    body=provider_response.output.explanation,
                    sql=provider_response.output.query_sql,
                    notices=provider_response.output.warnings,
                    model=provider_response.model,
                )
        except (ValueError, TypeError) as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned an invalid response",
                status.HTTP_502_BAD_GATEWAY,
            ) from exc
        return result.model_dump(by_alias=True, mode="json")

    def classify_dataset(self, request_id: str, dataset_context: dict[str, object]) -> dict[str, object]:
        """Ask the private gateway to classify every Catalog Dataset's columns."""
        if not self.settings.ai_gateway_base_url or not self.settings.ai_gateway_service_token:
            raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "AI gateway is not configured", status.HTTP_503_SERVICE_UNAVAILABLE)
        endpoint = urljoin(f"{self.settings.ai_gateway_base_url.rstrip('/')}/", self.settings.ai_gateway_classification_path.lstrip("/"))
        payload = {"mode": "classify_dataset", "request_id": request_id, "prompt": "Classify Catalog columns for RAG document construction.", "context": dataset_context, "selected_dataset_ids": []}
        try:
            response = httpx.post(endpoint, json=payload, headers={"Authorization": f"Bearer {self.settings.ai_gateway_service_token}", "Content-Type": "application/json", "X-Request-ID": request_id}, timeout=self.settings.ai_gateway_timeout_seconds)
            response.raise_for_status()
            body = response.json()
            output = body.get("output") if isinstance(body, dict) else None
            if not isinstance(output, dict):
                raise ValueError("classification output missing")
            return output
        except httpx.TimeoutException as exc:
            raise ApiError(ErrorCode.BACKEND_TIMEOUT, "AI gateway request timed out", status.HTTP_504_GATEWAY_TIMEOUT) from exc
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise ApiError(ErrorCode.INTERNAL_ERROR, "AI gateway classification failed", status.HTTP_502_BAD_GATEWAY) from exc

    def create_embeddings(self, inputs: list[str], *, model: str | None = None) -> list[list[float]]:
        if not self.settings.ai_gateway_base_url or not self.settings.ai_gateway_service_token:
            raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "AI gateway is not configured", status.HTTP_503_SERVICE_UNAVAILABLE)
        endpoint = urljoin(f"{self.settings.ai_gateway_base_url.rstrip('/')}/", self.settings.ai_gateway_embeddings_path.lstrip("/"))
        try:
            response = httpx.post(endpoint, json={"model": model or self.settings.rag_embedding_model, "input": inputs}, headers={"Authorization": f"Bearer {self.settings.ai_gateway_service_token}", "Content-Type": "application/json"}, timeout=self.settings.ai_gateway_timeout_seconds)
            response.raise_for_status()
            data = response.json().get("data")
            if not isinstance(data, list) or any(not isinstance(item, list) for item in data):
                raise ValueError("embedding data missing")
            return data
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise ApiError(ErrorCode.INTERNAL_ERROR, "AI gateway embeddings failed", status.HTTP_502_BAD_GATEWAY) from exc

    def health_check(self) -> bool:
        if not self.settings.ai_gateway_base_url or not self.settings.ai_gateway_service_token:
            return False
        endpoint = urljoin(f"{self.settings.ai_gateway_base_url.rstrip('/')}/", "health")
        try:
            response = httpx.get(
                endpoint,
                headers={"Authorization": f"Bearer {self.settings.ai_gateway_service_token}"},
                timeout=min(self.settings.ai_gateway_timeout_seconds, 5.0),
            )
        except httpx.RequestError:
            return False
        return response.status_code == 200
