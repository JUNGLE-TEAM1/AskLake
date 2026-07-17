from fastapi import APIRouter, Response, status
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import SessionLocal
from app.schemas.common import HealthResponse
from app.core.config import settings
from app.clients.opensearch_client import OpenSearchClient
from app.models.identity import AiGenerationUsageModel
from app.services.ai_gateway_client import AiGatewayClient
from app.services.catalog_model_service import list_catalog_model_artifacts

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health_check(response: Response) -> HealthResponse:
    database_ok = True
    database_message = "ok"

    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
    except SQLAlchemyError as error:
        database_ok = False
        database_message = error.__class__.__name__

    response.status_code = status.HTTP_200_OK if database_ok else status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthResponse(
        ok=database_ok,
        statusCode=response.status_code,
        database={"ok": database_ok, "message": database_message},
    )


@router.get("/health/ai")
def ai_health_check(response: Response) -> dict[str, object]:
    gateway = AiGatewayClient().health_status()
    ready = bool(gateway.get("ok"))
    available_modes = {
        str(mode)
        for mode in gateway.get("capabilities", [])
        if isinstance(mode, str)
    }
    opensearch_ready = False
    if settings.opensearch_base_url:
        try:
            opensearch_ready = OpenSearchClient(settings).health()
        except Exception:
            opensearch_ready = False
    definitions = [
        ("sql", "SQL 생성", ["query_sql"], "AI Gateway + MCP + Semantic RAG"),
        ("dashboard", "대시보드 생성", ["dashboard_assistant"], "AI Gateway + MCP + action guard"),
        ("transform", "데이터 가공식", ["etl_transform"], "AI Gateway + ETL SQL validator"),
        ("rag", "근거 검색", ["embeddings", "classify_dataset", "segment_document", "rag_query_plan", "rag_relevance"], "AI Gateway + OpenSearch + relevance gate"),
        ("review", "리뷰 분석", ["review_schema", "review_row"], "AI Gateway structured output"),
    ]
    capabilities = [
        {
            "id": capability_id,
            "label": label,
            "route": route,
            "status": "ready" if ready and all(mode in available_modes for mode in modes) and (capability_id != "rag" or opensearch_ready) else "unavailable",
        }
        for capability_id, label, modes, route in definitions
    ]
    ml_artifacts = list_catalog_model_artifacts()
    capabilities.append({
        "id": "ml",
        "label": "전통 ML 분류",
        "route": "검증된 portable model artifact 기반 추론",
        "status": "ready" if ml_artifacts else "unavailable",
        "artifactCount": len(ml_artifacts),
    })
    response.status_code = status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE
    usage_summary: dict[str, object]
    try:
        with SessionLocal() as db:
            usage_row = db.execute(select(
                func.count(AiGenerationUsageModel.request_id),
                func.coalesce(func.sum(AiGenerationUsageModel.input_tokens), 0),
                func.coalesce(func.sum(AiGenerationUsageModel.output_tokens), 0),
                func.coalesce(func.sum(AiGenerationUsageModel.estimated_cost_usd), 0.0),
            )).one()
        usage_summary = {
            "status": "ready",
            "requestCount": int(usage_row[0] or 0),
            "inputTokens": int(usage_row[1] or 0),
            "outputTokens": int(usage_row[2] or 0),
            "estimatedCostUsd": round(float(usage_row[3] or 0), 8),
        }
    except SQLAlchemyError:
        usage_summary = {"status": "unavailable"}
    return {
        "ok": ready,
        "status": "ready" if ready else "unavailable",
        "provider": gateway.get("provider"),
        "model": gateway.get("model"),
        "mcp": gateway.get("mcp", "unavailable"),
        "checks": gateway.get("checks", {}),
        "routing": gateway.get("routing", {}),
        "usage": usage_summary,
        "dependencies": {
            "aiGateway": "ready" if ready else "unavailable",
            "openSearch": "ready" if opensearch_ready else "unavailable",
        },
        "capabilities": capabilities,
    }
