from fastapi import APIRouter, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import SessionLocal
from app.schemas.common import HealthResponse
from app.core.config import settings
from app.clients.opensearch_client import OpenSearchClient
from app.services.ai_gateway_client import AiGatewayClient

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
        ("rag", "근거 검색", ["embeddings", "classify_dataset", "segment_document"], "AI Gateway + OpenSearch"),
        ("review", "리뷰 분석", ["review_schema", "review_row"], "AI Gateway + scalable runner"),
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
    capabilities.append({
        "id": "ml",
        "label": "전통 ML 분류",
        "route": "학습 아티팩트 기반 로컬 추론",
        "status": "ready",
    })
    response.status_code = status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE
    return {
        "ok": ready,
        "status": "ready" if ready else "unavailable",
        "provider": "gateway",
        "model": gateway.get("model"),
        "mcp": gateway.get("mcp", "unavailable"),
        "dependencies": {
            "aiGateway": "ready" if ready else "unavailable",
            "openSearch": "ready" if opensearch_ready else "unavailable",
        },
        "capabilities": capabilities,
    }
