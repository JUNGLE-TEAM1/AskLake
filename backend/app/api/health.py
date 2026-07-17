from fastapi import APIRouter, Response, status
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import SessionLocal
from app.schemas.common import HealthResponse
from app.core.config import settings
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.services.ai_gateway_client import AiGatewayClient
from app.services.realtime_event_service import realtime_event_dispatcher, realtime_event_hub
from app.services.realtime_feature_flags import resolve_realtime_feature_state
from app.services.realtime_metrics import realtime_metrics
from app.core.observability import metrics_snapshot

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health_check(response: Response) -> HealthResponse:
    return readiness_check(response)


@router.get("/health/live")
def liveness_check() -> dict[str, object]:
    return {"ok": True, "status": "alive"}


@router.get("/health/ready", response_model=HealthResponse)
def readiness_check(response: Response) -> HealthResponse:
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


@router.get("/health/metrics")
def observability_metrics() -> dict[str, object]:
    return {"ok": True, "metrics": metrics_snapshot()}


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
    return {"ok": ready, "status": "ready" if ready else "unavailable", "provider": "gateway"}


@router.get("/health/realtime")
def realtime_health_check(response: Response) -> dict[str, object]:
    state = resolve_realtime_feature_state(settings)
    if not state.realtime_events_enabled:
        return {
            "ok": True,
            "status": "disabled",
            "effectiveMode": state.dashboard_sync_mode,
        }
    database_ok = True
    event_cursor = 0
    try:
        with SessionLocal() as session:
            event_cursor = RealtimeEventRepository(session).max_cursor()
    except SQLAlchemyError:
        database_ok = False
    ready = database_ok and realtime_event_dispatcher.ready
    response.status_code = status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE
    metrics = realtime_metrics.snapshot()
    return {
        "ok": ready,
        "status": "ready" if ready else "unavailable",
        "effectiveMode": state.dashboard_sync_mode,
        "database": {"ok": database_ok},
        "dispatcher": {"ready": realtime_event_dispatcher.ready},
        "listener": {"ready": bool(metrics.get("listenerReady"))},
        "capacity": realtime_event_hub.capacity_snapshot(),
        "eventCursor": event_cursor,
    }
