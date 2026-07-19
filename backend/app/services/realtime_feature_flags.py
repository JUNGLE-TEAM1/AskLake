from dataclasses import dataclass
from typing import Iterable, Literal, cast

from app.core.config import Settings


DashboardSyncMode = Literal["polling", "hybrid", "sse"]
ClickHouseRealtimeConsumerOwner = Literal[
    "disabled",
    "kafka_engine_v1",
    "kafka_connect_v2",
]
ContinuousSqlServingMode = Literal["iceberg", "clickhouse"]
VALID_DASHBOARD_SYNC_MODES = frozenset({"polling", "hybrid", "sse"})
VALID_CLICKHOUSE_REALTIME_CONSUMER_OWNERS = frozenset(
    {"disabled", "kafka_engine_v1", "kafka_connect_v2"}
)


class RealtimeConsumerOwnershipError(ValueError):
    """Raised before two runtimes can claim the same ClickHouse generation."""


@dataclass(frozen=True)
class RealtimeFeatureState:
    dashboard_sync_mode: DashboardSyncMode
    realtime_events_enabled: bool
    continuous_sql_join_enabled: bool
    continuous_sql_serving_mode: ContinuousSqlServingMode
    clickhouse_continuous_join_enabled: bool
    clickhouse_realtime_v2_enabled: bool
    kafka_connect_sink_enabled: bool
    clickhouse_realtime_consumer_owner: ClickHouseRealtimeConsumerOwner
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
        continuous_sql_serving_mode=cast(
            ContinuousSqlServingMode,
            settings.continuous_sql_serving_mode,
        ),
        clickhouse_continuous_join_enabled=(
            continuous_sql_join_enabled
            and bool(settings.clickhouse_continuous_join_enabled)
        ),
        clickhouse_realtime_v2_enabled=bool(settings.clickhouse_realtime_v2_enabled),
        kafka_connect_sink_enabled=bool(settings.kafka_connect_sink_enabled),
        clickhouse_realtime_consumer_owner=cast(
            ClickHouseRealtimeConsumerOwner,
            settings.clickhouse_realtime_consumer_owner,
        ),
        latest_static_per_batch_enabled=(
            continuous_sql_join_enabled and bool(settings.latest_static_per_batch_enabled)
        ),
        static_change_backfill_enabled=(
            continuous_sql_join_enabled and bool(settings.static_change_backfill_enabled)
        ),
        fallback_reason=fallback_reason,
    )


def validate_clickhouse_consumer_ownership(
    *,
    job_id: str,
    generation: int,
    configured_owner: ClickHouseRealtimeConsumerOwner,
    claimed_owners: Iterable[ClickHouseRealtimeConsumerOwner],
) -> ClickHouseRealtimeConsumerOwner:
    """Fence one Job generation to one configured Kafka consumer implementation.

    PR2 only defines this pure guard. Runtime adapters must call it before they
    claim or resume a generation; this function does not start either consumer.
    """

    normalized_job_id = str(job_id or "").strip()
    if (
        not normalized_job_id
        or len(normalized_job_id) > 160
        or any(ord(character) < 32 for character in normalized_job_id)
    ):
        raise RealtimeConsumerOwnershipError(
            "job_id must be a bounded non-empty identifier"
        )
    if generation < 1:
        raise RealtimeConsumerOwnershipError("generation must be at least 1")
    if configured_owner not in VALID_CLICKHOUSE_REALTIME_CONSUMER_OWNERS:
        raise RealtimeConsumerOwnershipError("configured consumer owner is invalid")

    active_owners: set[ClickHouseRealtimeConsumerOwner] = set()
    for owner in claimed_owners:
        if owner not in VALID_CLICKHOUSE_REALTIME_CONSUMER_OWNERS:
            raise RealtimeConsumerOwnershipError("claimed consumer owner is invalid")
        if owner != "disabled":
            active_owners.add(owner)

    if len(active_owners) > 1:
        raise RealtimeConsumerOwnershipError(
            f"multiple consumer owners claimed job generation {generation}"
        )
    active_owner = next(iter(active_owners), "disabled")
    if active_owner != "disabled" and active_owner != configured_owner:
        raise RealtimeConsumerOwnershipError(
            f"consumer owner does not match active configuration for generation {generation}"
        )
    return cast(ClickHouseRealtimeConsumerOwner, active_owner)
