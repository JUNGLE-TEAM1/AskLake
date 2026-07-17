from dataclasses import dataclass
from typing import Literal, cast

from app.core.config import Settings


DashboardSyncMode = Literal["polling", "hybrid", "sse"]
VALID_DASHBOARD_SYNC_MODES = frozenset({"polling", "hybrid", "sse"})


@dataclass(frozen=True)
class RealtimeFeatureState:
    dashboard_sync_mode: DashboardSyncMode
    realtime_events_enabled: bool
    continuous_sql_join_enabled: bool
    latest_static_per_batch_enabled: bool
    static_change_backfill_enabled: bool
    fallback_reason: str | None


def resolve_realtime_feature_state(settings: Settings) -> RealtimeFeatureState:
    """Resolve deployment flags once so every client sees the same safe mode."""

    configured_mode = str(settings.dashboard_sync_mode or "polling").strip().casefold()
    fallback_reason: str | None = None

    if configured_mode not in VALID_DASHBOARD_SYNC_MODES:
        effective_mode: DashboardSyncMode = "polling"
        fallback_reason = "invalid_dashboard_sync_mode"
    else:
        effective_mode = cast(DashboardSyncMode, configured_mode)

    realtime_events_enabled = bool(settings.realtime_events_enabled)
    if effective_mode in {"hybrid", "sse"} and not realtime_events_enabled:
        effective_mode = "polling"
        fallback_reason = "realtime_events_disabled"

    continuous_sql_join_enabled = bool(settings.continuous_sql_join_enabled)
    return RealtimeFeatureState(
        dashboard_sync_mode=effective_mode,
        realtime_events_enabled=realtime_events_enabled,
        continuous_sql_join_enabled=continuous_sql_join_enabled,
        latest_static_per_batch_enabled=(
            continuous_sql_join_enabled and bool(settings.latest_static_per_batch_enabled)
        ),
        static_change_backfill_enabled=(
            continuous_sql_join_enabled and bool(settings.static_change_backfill_enabled)
        ),
        fallback_reason=fallback_reason,
    )
