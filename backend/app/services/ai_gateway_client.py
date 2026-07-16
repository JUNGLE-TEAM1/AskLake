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

    def generate_etl_transform(
        self,
        *,
        request_id: str,
        question: str,
        prompt_type: str,
        metadata: dict[str, Any],
        context: str,
        engine: str,
    ) -> dict[str, Any]:
        response = self._generate(
            mode="etl_transform",
            request_id=request_id,
            prompt=question,
            context={
                "promptType": prompt_type,
                "metadata": metadata,
                "additionalContext": context,
                "engine": engine,
            },
        )
        output = self._output(response, "ETL transform")
        output["model"] = str(response.get("model") or "")
        return output

    def generate_dashboard_response(
        self,
        *,
        request_id: str,
        prompt: str,
        dashboard_context: dict[str, Any],
        selected_dataset_ids: list[str],
        context_token: str | None,
        rag_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = self._generate(
            mode="dashboard_assistant",
            request_id=request_id,
            prompt=prompt,
            context={"dashboard": dashboard_context},
            selected_dataset_ids=selected_dataset_ids,
            context_token=context_token,
            rag_context=rag_context,
        )
        output = self._output(response, "dashboard assistant")
        output["model"] = str(response.get("model") or "") or None
        output["provider"] = "ai-gateway"
        return output

    def suggest_review_schema(
        self,
        *,
        request_id: str,
        source_columns: list[dict[str, Any]],
        sample_rows: list[list[Any]],
    ) -> dict[str, Any]:
        response = self._generate(
            mode="review_schema",
            request_id=request_id,
            prompt="Suggest an editable structured review-analysis schema.",
            context={
                "sourceColumns": source_columns[:40],
                "sampleRows": sample_rows[:3],
            },
        )
        output = self._output(response, "review schema")
        output["model"] = str(response.get("model") or "")
        output["source"] = "ai-gateway"
        output["status"] = "success"
        return output

    def _generate(
        self,
        *,
        mode: str,
        request_id: str,
        prompt: str,
        context: dict[str, Any],
        selected_dataset_ids: list[str] | None = None,
        context_token: str | None = None,
        rag_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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
        headers = {
            "Authorization": f"Bearer {self.settings.ai_gateway_service_token}",
            "Content-Type": "application/json",
            "X-Request-ID": request_id,
        }
        if context_token:
            headers["X-AskLake-AI-Context"] = context_token
        payload = {
            "mode": mode,
            "request_id": request_id,
            "prompt": prompt,
            "context": context,
            "selected_dataset_ids": selected_dataset_ids or [],
            "rag_context": rag_context or {},
        }
        try:
            response = httpx.post(
                endpoint,
                json=payload,
                headers=headers,
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
        if response.status_code in {502, 503, 504}:
            mapped_status = (
                status.HTTP_503_SERVICE_UNAVAILABLE
                if response.status_code == 503
                else status.HTTP_504_GATEWAY_TIMEOUT
                if response.status_code == 504
                else status.HTTP_502_BAD_GATEWAY
            )
            mapped_code = ErrorCode.SERVICE_UNAVAILABLE if response.status_code == 503 else ErrorCode.BACKEND_TIMEOUT if response.status_code == 504 else ErrorCode.INTERNAL_ERROR
            raise ApiError(mapped_code, "AI gateway generation failed", mapped_status)
        if response.status_code >= 400:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway rejected the request",
                status.HTTP_502_BAD_GATEWAY,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned invalid JSON",
                status.HTTP_502_BAD_GATEWAY,
            ) from exc
        if not isinstance(body, dict) or body.get("mode") != mode or not isinstance(body.get("output"), dict):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned an invalid response",
                status.HTTP_502_BAD_GATEWAY,
            )
        return body

    @staticmethod
    def _output(response: dict[str, Any], label: str) -> dict[str, Any]:
        output = response.get("output")
        if not isinstance(output, dict):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                f"AI gateway {label} output is missing",
                status.HTTP_502_BAD_GATEWAY,
            )
        return dict(output)

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
        return bool(self.health_status().get("ok"))

    def health_status(self) -> dict[str, Any]:
        if not self.settings.ai_gateway_base_url or not self.settings.ai_gateway_service_token:
            return {"ok": False, "status": "unconfigured", "capabilities": []}
        endpoint = urljoin(f"{self.settings.ai_gateway_base_url.rstrip('/')}/", "health")
        try:
            response = httpx.get(
                endpoint,
                headers={"Authorization": f"Bearer {self.settings.ai_gateway_service_token}"},
                timeout=min(self.settings.ai_gateway_timeout_seconds, 5.0),
            )
        except httpx.RequestError:
            return {"ok": False, "status": "unavailable", "capabilities": []}
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        return {
            **payload,
            "ok": response.status_code == 200 and payload.get("status") == "ok",
            "status": str(payload.get("status") or ("ready" if response.status_code == 200 else "unavailable")),
            "capabilities": payload.get("capabilities") if isinstance(payload.get("capabilities"), list) else [],
        }
