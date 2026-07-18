from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel


class RealtimeFeatureConfigResponse(CamelModel):
    dashboard_sync_mode: Literal["polling", "hybrid", "sse"]
    realtime_events_enabled: bool
    continuous_sql_join_enabled: bool
    clickhouse_continuous_join_enabled: bool
    clickhouse_realtime_v2_enabled: bool = False
    kafka_connect_sink_enabled: bool = False
    clickhouse_realtime_consumer_owner: Literal[
        "disabled",
        "kafka_engine_v1",
        "kafka_connect_v2",
    ] = "disabled"
    latest_static_per_batch_enabled: bool
    static_change_backfill_enabled: bool
    feature_scope: Literal["deployment"] = "deployment"
    fallback_reason: str | None = None
    heartbeat_seconds: int = Field(default=15, ge=5, le=60)
    reconnect_retry_ms: int = Field(default=3_000, ge=1_000, le=60_000)
    safety_poll_after_ms: int = Field(default=60_000, ge=10_000, le=300_000)


class RealtimeEventEnvelope(CamelModel):
    event_id: int = Field(ge=1)
    event_type: str
    schema_version: Literal[1] = 1
    scope_id: Literal["deployment"] = "deployment"
    resource_type: str
    resource_id: str
    aggregate_revision: int = Field(ge=0)
    occurred_at: str
    correlation_id: str
    invalidate: list[str] = Field(default_factory=list)
    payload: dict[str, object] = Field(default_factory=dict)


class RealtimeStatusResponse(CamelModel):
    enabled: bool
    effective_mode: Literal["polling", "hybrid", "sse"]
    ready: bool
    event_cursor: int = Field(ge=0)
    min_available_cursor: int = Field(ge=0)
    metrics: dict[str, int | float | bool | str | None] = Field(default_factory=dict)
