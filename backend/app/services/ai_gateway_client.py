import logging
import math
from typing import Any
from urllib.parse import urljoin

import httpx
from fastapi import status
from app.core.config import Settings, settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.models.identity import AiGenerationUsageModel
from app.schemas.common import ErrorCode
from app.services.ai_evidence import validate_used_evidence_ids


logger = logging.getLogger(__name__)


def _has_untrusted_generation_provenance(body: dict[str, Any]) -> bool:
    """Reject synthetic providers without confusing real failover with mock output."""

    provider = str(body.get("provider") or "").strip().casefold()
    # The private gateway uses ``openai_compatible_fallback`` for a second,
    # fully real provider. Routing through it is not a deterministic fallback
    # and must remain usable. The mock provider identifies itself explicitly.
    return provider == "mock" or provider.startswith("mock_") or provider.endswith("_mock")


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
        if not isinstance(context_token, str) or not context_token.strip():
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "AI context token is required",
                status.HTTP_401_UNAUTHORIZED,
            )
        response = self._generate(
            mode="query_sql",
            request_id=request_id,
            prompt=prompt,
            context={},
            current_query=current_query,
            base_dataset_id=base_dataset_id,
            selected_dataset_ids=selected_dataset_ids,
            context_token=context_token,
            rag_context=rag_context,
        )
        output = self._output(response, "SQL generation")
        query_sql = output.get("query_sql")
        explanation = output.get("explanation")
        warnings = output.get("warnings")
        if (
            not isinstance(query_sql, str)
            or not query_sql.strip()
            or not isinstance(explanation, str)
            or not isinstance(warnings, list)
            or any(not isinstance(item, str) for item in warnings)
        ):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned invalid SQL generation output",
                status.HTTP_502_BAD_GATEWAY,
            )
        used_evidence_ids = self._used_evidence_ids(output.get("usedEvidenceIds"), rag_context)
        return {
            "title": "SQL draft",
            "body": explanation,
            "sql": query_sql,
            "notices": warnings,
            "provider": str(response["provider"]),
            "model": str(response["model"]),
            "usedEvidenceIds": used_evidence_ids,
        }

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
        output["provider"] = str(response.get("provider") or "")
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
        output["usedEvidenceIds"] = self._used_evidence_ids(output.get("usedEvidenceIds"), rag_context)
        output["model"] = str(response.get("model") or "") or None
        output["provider"] = str(response.get("provider") or "")
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
        output["provider"] = str(response.get("provider") or "")
        output["status"] = "success"
        return output

    def plan_rag_query(
        self,
        *,
        request_id: str,
        query: str,
        datasets: list[dict[str, Any]],
    ) -> dict[str, Any]:
        response = self._generate(
            mode="rag_query_plan",
            request_id=request_id,
            prompt=query,
            context={"datasets": datasets[:100]},
        )
        output = self._output(response, "RAG query plan")
        output["model"] = str(response.get("model") or "")
        output["provider"] = str(response.get("provider") or "")
        return output

    def judge_rag_relevance(
        self,
        *,
        request_id: str,
        query: str,
        candidates: list[dict[str, Any]],
        applied_filters: dict[str, Any],
    ) -> dict[str, Any]:
        response = self._generate(
            mode="rag_relevance",
            request_id=request_id,
            prompt=query,
            context={
                "appliedFilters": applied_filters,
                "candidates": candidates[:24],
            },
        )
        output = self._output(response, "RAG relevance")
        output["model"] = str(response.get("model") or "")
        output["provider"] = str(response.get("provider") or "")
        return output

    def analyze_review_row(
        self,
        *,
        request_id: str,
        source_row: dict[str, Any],
        requested_columns: list[dict[str, Any]],
    ) -> dict[str, Any]:
        response = self._generate(
            mode="review_row",
            request_id=request_id,
            prompt="Analyze this preview row using only the requested column definitions.",
            context={
                "sourceRow": source_row,
                "requestedColumns": requested_columns[:64],
            },
        )
        output = self._output(response, "review row")
        output["model"] = str(response.get("model") or "")
        output["provider"] = str(response.get("provider") or "")
        return output

    def _generate(
        self,
        *,
        mode: str,
        request_id: str,
        prompt: str,
        context: dict[str, Any],
        current_query: str | None = None,
        base_dataset_id: str | None = None,
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
            "current_query": current_query,
            "base_dataset_id": base_dataset_id,
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
        if len(response.content) > self.settings.ai_gateway_max_response_bytes:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway response exceeded the configured size limit",
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
        if (
            not isinstance(body, dict)
            or body.get("request_id") != request_id
            or body.get("mode") != mode
            or not isinstance(body.get("output"), dict)
            or not isinstance(body.get("provider"), str)
            or not body["provider"].strip()
            or not isinstance(body.get("model"), str)
            or not body["model"].strip()
            or ("usage" in body and not isinstance(body.get("usage"), dict))
        ):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned an invalid response",
                status.HTTP_502_BAD_GATEWAY,
            )
        if _has_untrusted_generation_provenance(body):
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned untrusted generation provenance",
                status.HTTP_502_BAD_GATEWAY,
            )
        self._persist_generation_usage(body, request_id=request_id, mode=mode)
        return body

    @staticmethod
    def _persist_generation_usage(body: dict[str, Any], *, request_id: str, mode: str) -> None:
        AiGatewayClient.persist_generation_usage_batch(
            [{
                "requestId": request_id,
                "provider": body.get("provider"),
                "model": body.get("model"),
                "usage": body.get("usage"),
            }],
            mode=mode,
        )

    @staticmethod
    def persist_generation_usage_batch(records: list[dict[str, Any]], *, mode: str) -> None:
        """Persist a bounded group of gateway calls without affecting the user request."""

        if not isinstance(records, list) or not records:
            return
        try:
            with SessionLocal() as db:
                seen_request_ids: set[str] = set()
                for item in records[:1_000]:
                    if not isinstance(item, dict):
                        continue
                    request_id = str(item.get("requestId") or item.get("request_id") or "").strip()
                    provider = str(item.get("provider") or "").strip()
                    model = str(item.get("model") or "").strip()
                    usage = item.get("usage")
                    if (
                        not request_id
                        or len(request_id) > 255
                        or request_id in seen_request_ids
                        or not provider
                        or not model
                        or not isinstance(usage, dict)
                    ):
                        continue
                    seen_request_ids.add(request_id)
                    record = db.get(AiGenerationUsageModel, request_id)
                    if record is None:
                        record = AiGenerationUsageModel(request_id=request_id)
                        db.add(record)
                    record.mode = str(mode or "unknown")[:64]
                    record.provider = provider[:100]
                    record.model = model[:255]
                    record.input_tokens = _nonnegative_int(usage.get("inputTokens") or usage.get("input_tokens"))
                    record.output_tokens = _nonnegative_int(usage.get("outputTokens") or usage.get("output_tokens"))
                    record.total_tokens = _nonnegative_int(usage.get("totalTokens") or usage.get("total_tokens"))
                    record.estimated_cost_usd = _nonnegative_float(usage.get("estimatedCostUsd") or usage.get("estimated_cost_usd"))
                db.commit()
        except Exception:
            logger.exception("ai_generation_usage_batch_persistence_failed mode=%s count=%s", mode, len(records))

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

    @staticmethod
    def _used_evidence_ids(value: object, rag_context: dict[str, Any] | None) -> list[str]:
        try:
            return validate_used_evidence_ids(value, rag_context)
        except ValueError as exc:
            raise ApiError(
                ErrorCode.INTERNAL_ERROR,
                "AI gateway returned invalid evidence provenance",
                status.HTTP_502_BAD_GATEWAY,
            ) from exc

    def classify_dataset(self, request_id: str, dataset_context: dict[str, object]) -> dict[str, object]:
        """Ask the private gateway to classify every Catalog Dataset's columns."""
        response = self._generate(
            mode="classify_dataset",
            request_id=request_id,
            prompt="Classify Catalog columns for RAG document construction.",
            context=dict(dataset_context),
        )
        output = self._output(response, "RAG classification")
        output["model"] = str(response.get("model") or "")
        output["provider"] = str(response.get("provider") or "")
        return output

    def create_embeddings(self, inputs: list[str], *, model: str | None = None) -> list[list[float]]:
        return self.create_embeddings_with_metadata(inputs, model=model)["data"]

    def create_embeddings_with_metadata(
        self,
        inputs: list[str],
        *,
        model: str | None = None,
    ) -> dict[str, Any]:
        if not self.settings.ai_gateway_base_url or not self.settings.ai_gateway_service_token:
            raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "AI gateway is not configured", status.HTTP_503_SERVICE_UNAVAILABLE)
        if (
            not inputs
            or len(inputs) > self.settings.rag_embedding_batch_size
            or any(not isinstance(item, str) or not item.strip() for item in inputs)
        ):
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Embedding inputs are invalid",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        requested_model = model or self.settings.rag_embedding_model
        endpoint = urljoin(f"{self.settings.ai_gateway_base_url.rstrip('/')}/", self.settings.ai_gateway_embeddings_path.lstrip("/"))
        try:
            response = httpx.post(endpoint, json={"model": requested_model, "input": inputs}, headers={"Authorization": f"Bearer {self.settings.ai_gateway_service_token}", "Content-Type": "application/json"}, timeout=self.settings.ai_gateway_timeout_seconds)
        except httpx.TimeoutException as exc:
            raise ApiError(ErrorCode.BACKEND_TIMEOUT, "AI gateway embeddings timed out", status.HTTP_504_GATEWAY_TIMEOUT) from exc
        except httpx.RequestError as exc:
            raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "AI gateway is unavailable", status.HTTP_503_SERVICE_UNAVAILABLE) from exc
        if response.status_code == 503:
            raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "AI gateway embeddings are unavailable", status.HTTP_503_SERVICE_UNAVAILABLE)
        if response.status_code == 504:
            raise ApiError(ErrorCode.BACKEND_TIMEOUT, "AI gateway embeddings timed out", status.HTTP_504_GATEWAY_TIMEOUT)
        if response.status_code >= 400:
            raise ApiError(ErrorCode.INTERNAL_ERROR, "AI gateway embeddings failed", status.HTTP_502_BAD_GATEWAY)
        if len(response.content) > self.settings.ai_gateway_max_embedding_response_bytes:
            raise ApiError(ErrorCode.INTERNAL_ERROR, "AI gateway embeddings response exceeded the configured size limit", status.HTTP_502_BAD_GATEWAY)
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("embedding response missing")
            provider = payload.get("provider")
            response_model = payload.get("model")
            dimensions = payload.get("dimensions")
            data = payload.get("data")
            if not isinstance(provider, str) or not provider.strip():
                raise ValueError("embedding provider missing")
            if response_model != requested_model:
                raise ValueError("embedding model mismatch")
            if dimensions != self.settings.rag_embedding_dimensions:
                raise ValueError("embedding dimensions mismatch")
            if not isinstance(data, list) or len(data) != len(inputs):
                raise ValueError("embedding count mismatch")
            normalized: list[list[float]] = []
            for vector in data:
                if not isinstance(vector, list) or len(vector) != dimensions:
                    raise ValueError("embedding vector dimensions mismatch")
                parsed_vector: list[float] = []
                for component in vector:
                    if isinstance(component, bool) or not isinstance(component, (int, float)):
                        raise ValueError("embedding component is not numeric")
                    numeric = float(component)
                    if not math.isfinite(numeric):
                        raise ValueError("embedding component is not finite")
                    parsed_vector.append(numeric)
                normalized.append(parsed_vector)
            return {
                "provider": provider.strip(),
                "model": response_model,
                "dimensions": dimensions,
                "data": normalized,
            }
        except (ValueError, TypeError) as exc:
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
                timeout=min(self.settings.ai_gateway_timeout_seconds, 15.0),
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


def _nonnegative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _nonnegative_float(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return max(0.0, parsed) if math.isfinite(parsed) else 0.0
