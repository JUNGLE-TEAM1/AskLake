from fastapi import APIRouter, Response, status
from sqlalchemy import text
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
from app.realtime.application.ingest_service import RealtimeIngestService
from app.realtime.infrastructure.kafka_connect_gateway import KafkaConnectError
from app.services.clickhouse_client import ClickHouseClient, ClickHouseError

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
    if settings.ai_query_provider != "gateway":
        return {"ok": True, "status": "disabled", "provider": "direct"}
    gateway_status = AiGatewayClient().health_status()
    ready = bool(gateway_status.get("ok"))
    response.status_code = status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE
    safe_gateway_status: dict[str, object] = {}
    for key in ("service", "provider", "model", "mcp"):
        value = gateway_status.get(key)
        if isinstance(value, str):
            safe_gateway_status[key] = value
    checks = gateway_status.get("checks")
    if isinstance(checks, dict):
        safe_gateway_status["checks"] = {
            key: value
            for key in ("internalAuth", "provider", "mcp")
            if isinstance((value := checks.get(key)), str)
        }
    capabilities = gateway_status.get("capabilities")
    safe_gateway_status["capabilities"] = (
        [value for value in capabilities if isinstance(value, str)]
        if isinstance(capabilities, list)
        else []
    )
    return {
        "ok": ready,
        "status": "ready" if ready else str(gateway_status.get("status") or "unavailable"),
        "provider": "gateway",
        "gateway": safe_gateway_status,
    }


@router.get("/health/realtime")
def realtime_health_check(response: Response) -> dict[str, object]:
    state = resolve_realtime_feature_state(settings)
    v2_ready = False
    v2_status = "disabled"
    connector_state = "DISABLED"
    task_states: list[str] = []
    clickhouse_ready = False
    worker_ready = False
    if state.clickhouse_realtime_v2_enabled:
        try:
            probe = RealtimeIngestService().probe()
            worker_ready = probe.runtime_ready
            connector_state = probe.connector_state
            task_states = list(probe.task_states)
        except (KafkaConnectError, ValueError):
            connector_state = "UNAVAILABLE"
        client: ClickHouseClient | None = None
        try:
            client = ClickHouseClient.realtime_v2_reader()
            clickhouse_ready = client.ping()
        except (ClickHouseError, ValueError):
            clickhouse_ready = False
        finally:
            if client is not None:
                client.close()
        # A fresh deployment has no connector until a Continuous SQL Job is
        # started. Readiness must verify the worker and ClickHouse, not require
        # a connector that cannot exist yet.
        v2_ready = worker_ready and clickhouse_ready
        v2_status = "ready" if v2_ready else "unavailable"
    realtime_v2 = {
        "enabled": state.clickhouse_realtime_v2_enabled,
        "ready": v2_ready,
        "status": v2_status,
        "consumerOwner": state.clickhouse_realtime_consumer_owner,
        "connector": {
            "enabled": state.kafka_connect_sink_enabled,
            "configured": bool(
                state.kafka_connect_sink_enabled
                and settings.kafka_connect_url
                and settings.kafka_connect_connector_name
            ),
            "state": connector_state,
            "taskStates": task_states,
            "workerReady": worker_ready,
        },
        "clickhouse": {"ready": clickhouse_ready},
    }
    if not state.realtime_events_enabled:
        if state.clickhouse_realtime_v2_enabled:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {
            "ok": not state.clickhouse_realtime_v2_enabled,
            "status": (
                "not_ready"
                if state.clickhouse_realtime_v2_enabled
                else "disabled"
            ),
            "effectiveMode": state.dashboard_sync_mode,
            "v2": realtime_v2,
        }
    database_ok = True
    event_cursor = 0
    try:
        with SessionLocal() as session:
            event_cursor = RealtimeEventRepository(session).max_cursor()
    except SQLAlchemyError:
        database_ok = False
    ready = (
        database_ok
        and realtime_event_dispatcher.ready
        and (not state.clickhouse_realtime_v2_enabled or v2_ready)
    )
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
        "v2": realtime_v2,
    }
