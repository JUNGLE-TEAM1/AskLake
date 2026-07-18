import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import ValidationError
from sse_starlette.sse import EventSourceResponse

from app.core.auth_context import ActorContext, get_actor_context, resolve_actor_context
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_card_repository import get_dashboard_card
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.realtime import (
    RealtimeAuditedSkipRequest,
    RealtimeEventEnvelope,
    RealtimeFeatureConfigResponse,
    RealtimeIngestConnectorRequest,
    RealtimeStatusResponse,
)
from app.realtime.application.ingest_service import RealtimeIngestService
from app.realtime.domain.source_position import SourcePosition
from app.realtime.infrastructure.kafka_connect_gateway import KafkaConnectError
from app.realtime.repositories.receipt_repository import ReceiptRepository
from app.services.auth_service import SESSION_COOKIE_NAME
from app.services.dashboard_card_service import with_dashboard_permissions
from app.services.realtime_event_contract import REALTIME_SCOPE_ID
from app.services.realtime_event_service import (
    RealtimeConnectionLimitError,
    RealtimeQueueOverflow,
    RealtimeSubscription,
    realtime_event_dispatcher,
    realtime_event_hub,
)
from app.services.realtime_feature_flags import resolve_realtime_feature_state
from app.services.realtime_metrics import realtime_metrics
from app.services.resource_permission_service import (
    dataset_with_persisted_permission_grants,
    permissions_for_actor_with_governance,
)


router = APIRouter(prefix="/realtime", tags=["realtime"])


@dataclass(frozen=True)
class StreamIdentity:
    actor: ActorContext
    actor_key: str
    session_token: str | None
    actor_name_header: str
    actor_role_header: str
    actor_groups_header: str | None


@dataclass(frozen=True)
class ReplaySnapshot:
    min_cursor: int
    max_cursor: int
    events: list[RealtimeEventEnvelope]


@router.get("/config", response_model=RealtimeFeatureConfigResponse)
def get_realtime_feature_config(
    _actor: ActorContext = Depends(get_actor_context),
) -> RealtimeFeatureConfigResponse:
    state = resolve_realtime_feature_state(settings)
    return RealtimeFeatureConfigResponse(
        dashboard_sync_mode=state.dashboard_sync_mode,
        realtime_events_enabled=state.realtime_events_enabled,
        continuous_sql_join_enabled=state.continuous_sql_join_enabled,
        clickhouse_continuous_join_enabled=state.clickhouse_continuous_join_enabled,
        clickhouse_realtime_v2_enabled=state.clickhouse_realtime_v2_enabled,
        kafka_connect_sink_enabled=state.kafka_connect_sink_enabled,
        clickhouse_realtime_consumer_owner=(
            state.clickhouse_realtime_consumer_owner
        ),
        latest_static_per_batch_enabled=state.latest_static_per_batch_enabled,
        static_change_backfill_enabled=state.static_change_backfill_enabled,
        fallback_reason=state.fallback_reason,
        heartbeat_seconds=settings.realtime_heartbeat_seconds,
    )


@router.get("/status", response_model=RealtimeStatusResponse)
def get_realtime_status(
    _actor: ActorContext = Depends(get_actor_context),
) -> RealtimeStatusResponse:
    state = resolve_realtime_feature_state(settings)
    with SessionLocal() as db:
        min_cursor, max_cursor = RealtimeEventRepository(db).cursor_bounds()
    enabled = state.realtime_events_enabled
    metrics = realtime_metrics.snapshot()
    metrics.update(realtime_event_hub.capacity_snapshot())
    return RealtimeStatusResponse(
        enabled=enabled,
        effective_mode=state.dashboard_sync_mode,
        ready=(not enabled) or realtime_event_dispatcher.ready,
        event_cursor=max_cursor,
        min_available_cursor=min_cursor,
        metrics=metrics,
    )


def _require_realtime_operator(actor: ActorContext) -> None:
    if not actor.is_admin:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Realtime ingest operations require an administrator.",
            status.HTTP_403_FORBIDDEN,
        )


@router.get("/ingest/status")
def get_realtime_ingest_status(
    actor: ActorContext = Depends(get_actor_context),
) -> dict[str, object]:
    _require_realtime_operator(actor)
    state = resolve_realtime_feature_state(settings)
    if not state.clickhouse_realtime_v2_enabled:
        return {"enabled": False, "ready": False, "status": "disabled"}
    try:
        probe = RealtimeIngestService().probe()
    except (KafkaConnectError, ValueError):
        return {"enabled": True, "ready": False, "status": "unavailable"}
    return {
        "enabled": True,
        "ready": probe.ready,
        "status": "ready" if probe.ready else "degraded",
        "connectorState": probe.connector_state,
        "taskStates": list(probe.task_states),
    }


@router.put("/ingest/connector")
def register_realtime_ingest_connector(
    request: RealtimeIngestConnectorRequest,
    actor: ActorContext = Depends(get_actor_context),
) -> dict[str, object]:
    _require_realtime_operator(actor)
    if not settings.clickhouse_realtime_v2_enabled:
        raise ApiError(
            ErrorCode.CONFLICT,
            "ClickHouse Realtime V2 is disabled.",
            status.HTTP_409_CONFLICT,
        )
    try:
        return RealtimeIngestService().register(
            topic=request.topic,
            table=request.table,
            dlq_topic=request.dlq_topic,
            generation=request.generation,
        )
    except (KafkaConnectError, ValueError) as exc:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Kafka Connect connector registration failed.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from exc


@router.post("/ingest/exceptions/{pipeline_version_id}/{topic}/{partition}/{offset}/audited-skip")
def approve_realtime_ingest_skip(
    pipeline_version_id: str,
    topic: str,
    partition: int,
    offset: int,
    request: RealtimeAuditedSkipRequest,
    actor: ActorContext = Depends(get_actor_context),
) -> dict[str, object]:
    _require_realtime_operator(actor)
    position = SourcePosition(topic, partition, offset)
    with SessionLocal() as db:
        approved = ReceiptRepository(db).approve_skip(
            pipeline_version_id=pipeline_version_id,
            position=position,
            actor=actor.name,
            reason=request.reason,
        )
        if approved:
            db.commit()
        else:
            db.rollback()
    if not approved:
        raise ApiError(
            ErrorCode.CONFLICT,
            "The ingest exception is not eligible for audited skip.",
            status.HTTP_409_CONFLICT,
        )
    return {"approved": True, "sourcePosition": position.document()}


@router.get(
    "/events",
    response_class=EventSourceResponse,
    response_model=None,
    summary="Replayable realtime change notification stream",
)
async def stream_realtime_events(
    request: Request,
    dataset_ids: Annotated[
        str,
        Query(alias="datasetIds", min_length=1, max_length=16_000),
    ],
    dashboard_id: Annotated[
        str,
        Query(alias="dashboardId", min_length=1, max_length=120),
    ],
    cursor: Annotated[int | None, Query(ge=0)] = None,
) -> EventSourceResponse:
    state = resolve_realtime_feature_state(settings)
    if not state.realtime_events_enabled or state.dashboard_sync_mode == "polling":
        raise ApiError(
            ErrorCode.CONFLICT,
            "Realtime event streaming is disabled.",
            status.HTTP_409_CONFLICT,
            {"effectiveMode": state.dashboard_sync_mode},
        )
    if not realtime_event_dispatcher.ready:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Realtime event dispatcher is not ready.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    normalized_dataset_ids = _parse_dataset_ids(dataset_ids)
    identity = _resolve_stream_identity(request)
    with SessionLocal() as permission_db:
        can_stream = (
            _actor_can_view_dashboard(
                identity.actor,
                dashboard_id,
                db=permission_db,
            )
            and _actor_can_query_datasets(
                identity.actor,
                normalized_dataset_ids,
                db=permission_db,
            )
        )
    if not can_stream:
        realtime_metrics.increment("authRejections")
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Actor is not allowed to stream one or more requested datasets.",
            status.HTTP_403_FORBIDDEN,
        )

    resolved_cursor = _parse_reconnect_cursor(request, cursor)
    try:
        subscription = realtime_event_hub.subscribe(
            actor_key=identity.actor_key,
            resources={
                ("dashboard", dashboard_id),
                *(("dataset", dataset_id) for dataset_id in normalized_dataset_ids),
            },
        )
    except RealtimeConnectionLimitError as error:
        raise ApiError(
            ErrorCode.RATE_LIMITED,
            str(error),
            status.HTTP_429_TOO_MANY_REQUESTS,
        ) from error

    generator = _event_stream(
        request=request,
        subscription=subscription,
        identity=identity,
        dashboard_id=dashboard_id,
        dataset_ids=normalized_dataset_ids,
        initial_cursor=resolved_cursor,
    )
    return EventSourceResponse(
        generator,
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
        ping=None,
        send_timeout=settings.realtime_sse_send_timeout_seconds,
    )


async def _event_stream(
    *,
    request: Request,
    subscription: RealtimeSubscription,
    identity: StreamIdentity,
    dashboard_id: str,
    dataset_ids: set[str],
    initial_cursor: int | None,
):
    last_cursor = max(0, initial_cursor or 0)
    try:
        replay_snapshot = await asyncio.to_thread(
            _load_replay_snapshot,
            last_cursor,
            dashboard_id,
            dataset_ids,
        )
        if initial_cursor is None:
            last_cursor = replay_snapshot.max_cursor
            replay_events: list[RealtimeEventEnvelope] = []
        else:
            replay_events = replay_snapshot.events

        yield _system_event(
            "stream.ready",
            {
                "currentCursor": replay_snapshot.max_cursor,
                "heartbeatSeconds": settings.realtime_heartbeat_seconds,
                "scopeId": REALTIME_SCOPE_ID,
                "serverTime": datetime.now(UTC).isoformat(),
            },
            retry=3_000,
        )

        cursor_expired = (
            (replay_snapshot.min_cursor > 0 and last_cursor < replay_snapshot.min_cursor - 1)
            or (last_cursor > replay_snapshot.max_cursor and replay_snapshot.max_cursor >= 0)
        )
        replay_overflow = len(replay_events) > settings.realtime_replay_limit
        if cursor_expired or replay_overflow:
            realtime_metrics.increment("resyncRequired")
            yield _system_event(
                "system.resync_required",
                {
                    "reason": "cursor_expired" if cursor_expired else "replay_limit_exceeded",
                    "minAvailableCursor": replay_snapshot.min_cursor,
                    "currentCursor": replay_snapshot.max_cursor,
                },
            )
            return

        for event in replay_events:
            if event.event_id <= last_cursor:
                continue
            yield _domain_event(event)
            last_cursor = event.event_id
            realtime_metrics.increment("eventsReplayed")

        while not await request.is_disconnected():
            try:
                item = await asyncio.wait_for(
                    subscription.get(),
                    timeout=settings.realtime_heartbeat_seconds,
                )
            except TimeoutError:
                is_authorized = await asyncio.to_thread(
                    _stream_identity_is_authorized,
                    identity,
                    dashboard_id,
                    dataset_ids,
                )
                if not is_authorized:
                    realtime_metrics.increment("authRejections")
                    yield _system_event(
                        "system.authorization_changed",
                        {"reason": "session_or_permission_changed"},
                    )
                    return
                yield _system_event(
                    "system.heartbeat",
                    {
                        "currentCursor": last_cursor,
                        "serverTime": datetime.now(UTC).isoformat(),
                    },
                )
                continue

            if isinstance(item, RealtimeQueueOverflow):
                realtime_metrics.increment("resyncRequired")
                yield _system_event(
                    "system.resync_required",
                    {"reason": item.reason, "currentCursor": last_cursor},
                )
                return
            if item.event_id <= last_cursor:
                continue
            yield _domain_event(item)
            last_cursor = item.event_id
    finally:
        subscription.close()


def _load_replay_snapshot(
    cursor: int,
    dashboard_id: str,
    dataset_ids: set[str],
) -> ReplaySnapshot:
    with SessionLocal() as db:
        repository = RealtimeEventRepository(db)
        min_cursor, max_cursor = repository.cursor_bounds()
        events = repository.replay(
            after_cursor=cursor,
            resources={
                ("dashboard", dashboard_id),
                *(("dataset", dataset_id) for dataset_id in dataset_ids),
            },
            limit=settings.realtime_replay_limit + 1,
            through_cursor=max_cursor,
        )
        return ReplaySnapshot(
            min_cursor=min_cursor,
            max_cursor=max_cursor,
            events=events,
        )


def _resolve_stream_identity(request: Request) -> StreamIdentity:
    session_token = request.cookies.get(SESSION_COOKIE_NAME)
    actor_name = request.headers.get("X-AskLake-User", "Admin User")
    actor_role = request.headers.get("X-AskLake-Role", "admin")
    actor_groups = request.headers.get("X-AskLake-Groups")
    with SessionLocal() as db:
        actor = resolve_actor_context(
            db=db,
            session_token=session_token,
            actor_name=actor_name,
            actor_role=actor_role,
            actor_groups=actor_groups,
        )
    stable_identity = actor.id or actor.email or actor.name
    actor_key = hashlib.sha256(
        stable_identity.encode("utf-8")
    ).hexdigest()
    return StreamIdentity(
        actor=actor,
        actor_key=actor_key,
        session_token=session_token,
        actor_name_header=actor_name,
        actor_role_header=actor_role,
        actor_groups_header=actor_groups,
    )


def _stream_identity_is_authorized(
    identity: StreamIdentity,
    dashboard_id: str,
    dataset_ids: set[str],
) -> bool:
    try:
        with SessionLocal() as db:
            current_actor = resolve_actor_context(
                db=db,
                session_token=identity.session_token,
                actor_name=identity.actor_name_header,
                actor_role=identity.actor_role_header,
                actor_groups=identity.actor_groups_header,
            )
            previous_identity = identity.actor.id or identity.actor.email or identity.actor.name
            current_identity = current_actor.id or current_actor.email or current_actor.name
            if previous_identity != current_identity:
                return False
            return (
                _actor_can_view_dashboard(current_actor, dashboard_id, db=db)
                and _actor_can_query_datasets(current_actor, dataset_ids, db=db)
            )
    except (ApiError, ValidationError):
        return False


def _actor_can_query_datasets(
    actor: ActorContext,
    dataset_ids: set[str],
    *,
    db=None,
) -> bool:
    owns_session = db is None
    session = db or SessionLocal()
    try:
        repository = CatalogRepository(session)
        for dataset_id in dataset_ids:
            payload = repository.get_dataset_payload(dataset_id)
            if payload is None:
                return False
            dataset = dataset_with_persisted_permission_grants(
                session,
                CatalogDatasetResponse.model_validate(payload),
            )
            grants = [
                grant.model_dump(by_alias=True)
                if hasattr(grant, "model_dump")
                else grant
                for grant in dataset.permission_grants
            ]
            permissions = permissions_for_actor_with_governance(
                session,
                actor,
                owner=dataset.owner,
                grants=grants,
                resource_id=dataset.id,
                resource_type="dataset",
            )
            if not permissions.can_query:
                return False
        return True
    except (ApiError, ValidationError):
        return False
    finally:
        if owns_session:
            session.close()


def _actor_can_view_dashboard(
    actor: ActorContext,
    dashboard_id: str,
    *,
    db=None,
) -> bool:
    owns_session = db is None
    session = db or SessionLocal()
    try:
        dashboard = get_dashboard_card(session, dashboard_id)
        if dashboard is None:
            return False
        return with_dashboard_permissions(session, dashboard, actor).permissions.can_view
    except (ApiError, ValidationError):
        return False
    finally:
        if owns_session:
            session.close()


def _parse_dataset_ids(value: str) -> set[str]:
    dataset_ids = {
        item.strip()
        for item in value.split(",")
        if item.strip()
    }
    if not dataset_ids or len(dataset_ids) > 100:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "datasetIds must contain between 1 and 100 dataset ids.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if any(len(dataset_id) > 120 for dataset_id in dataset_ids):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "datasetIds contains an invalid dataset id.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return dataset_ids


def _parse_reconnect_cursor(request: Request, query_cursor: int | None) -> int | None:
    last_event_id = request.headers.get("Last-Event-ID")
    if last_event_id is None or not last_event_id.strip():
        return query_cursor
    try:
        header_cursor = int(last_event_id)
    except ValueError as error:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Last-Event-ID must be a non-negative integer.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ) from error
    if header_cursor < 0:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Last-Event-ID must be a non-negative integer.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return max(header_cursor, query_cursor or 0)


def _domain_event(event: RealtimeEventEnvelope) -> dict[str, Any]:
    return {
        "id": str(event.event_id),
        "event": event.event_type,
        "data": json.dumps(
            event.model_dump(by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    }


def _system_event(
    event_type: str,
    payload: dict[str, Any],
    *,
    retry: int | None = None,
) -> dict[str, Any]:
    event = {
        "event": event_type,
        "data": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    }
    if retry is not None:
        event["retry"] = retry
    return event
