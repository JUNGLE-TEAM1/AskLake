from fastapi import APIRouter, Depends

from app.core.auth_context import ActorContext, get_actor_context
from app.core.config import settings
from app.schemas.realtime import RealtimeFeatureConfigResponse
from app.services.realtime_feature_flags import resolve_realtime_feature_state


router = APIRouter(prefix="/realtime", tags=["realtime"])


@router.get("/config", response_model=RealtimeFeatureConfigResponse)
def get_realtime_feature_config(
    _actor: ActorContext = Depends(get_actor_context),
) -> RealtimeFeatureConfigResponse:
    state = resolve_realtime_feature_state(settings)
    return RealtimeFeatureConfigResponse(
        dashboard_sync_mode=state.dashboard_sync_mode,
        realtime_events_enabled=state.realtime_events_enabled,
        continuous_sql_join_enabled=state.continuous_sql_join_enabled,
        latest_static_per_batch_enabled=state.latest_static_per_batch_enabled,
        static_change_backfill_enabled=state.static_change_backfill_enabled,
        fallback_reason=state.fallback_reason,
    )
