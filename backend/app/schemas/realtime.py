from typing import Literal

from app.schemas.common import CamelModel


class RealtimeFeatureConfigResponse(CamelModel):
    dashboard_sync_mode: Literal["polling", "hybrid", "sse"]
    realtime_events_enabled: bool
    continuous_sql_join_enabled: bool
    latest_static_per_batch_enabled: bool
    static_change_backfill_enabled: bool
    feature_scope: Literal["deployment"] = "deployment"
    fallback_reason: str | None = None
