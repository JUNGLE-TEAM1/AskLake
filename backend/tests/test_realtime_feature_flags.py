import os
import unittest
from unittest.mock import patch

from app.api.realtime import get_realtime_feature_config
from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.services.realtime_feature_flags import resolve_realtime_feature_state


REALTIME_ENV_KEYS = {
    "DASHBOARD_SYNC_MODE",
    "REALTIME_EVENTS_ENABLED",
    "CONTINUOUS_SQL_JOIN_ENABLED",
    "CLICKHOUSE_CONTINUOUS_JOIN_ENABLED",
    "LATEST_STATIC_PER_BATCH_ENABLED",
    "STATIC_CHANGE_BACKFILL_ENABLED",
}


def settings_with_env(**values: str) -> Settings:
    environment = {key: value for key, value in os.environ.items() if key not in REALTIME_ENV_KEYS}
    environment.update(values)
    with patch.dict(os.environ, environment, clear=True):
        return Settings(_env_file=None)


class RealtimeFeatureFlagTests(unittest.TestCase):
    def test_defaults_preserve_polling_and_disable_new_runtime(self) -> None:
        state = resolve_realtime_feature_state(settings_with_env())

        self.assertEqual(state.dashboard_sync_mode, "polling")
        self.assertFalse(state.realtime_events_enabled)
        self.assertFalse(state.continuous_sql_join_enabled)
        self.assertFalse(state.clickhouse_continuous_join_enabled)
        self.assertFalse(state.latest_static_per_batch_enabled)
        self.assertFalse(state.static_change_backfill_enabled)
        self.assertIsNone(state.fallback_reason)

    def test_invalid_dashboard_mode_fails_closed_to_polling(self) -> None:
        state = resolve_realtime_feature_state(settings_with_env(
            DASHBOARD_SYNC_MODE="websocket",
            REALTIME_EVENTS_ENABLED="true",
        ))

        self.assertEqual(state.dashboard_sync_mode, "polling")
        self.assertEqual(state.fallback_reason, "invalid_dashboard_sync_mode")

    def test_sse_requires_realtime_event_backbone(self) -> None:
        state = resolve_realtime_feature_state(settings_with_env(
            DASHBOARD_SYNC_MODE="sse",
            REALTIME_EVENTS_ENABLED="false",
        ))

        self.assertEqual(state.dashboard_sync_mode, "polling")
        self.assertEqual(state.fallback_reason, "realtime_events_disabled")

    def test_advanced_static_modes_require_continuous_sql(self) -> None:
        disabled = resolve_realtime_feature_state(settings_with_env(
            CONTINUOUS_SQL_JOIN_ENABLED="false",
            LATEST_STATIC_PER_BATCH_ENABLED="true",
            STATIC_CHANGE_BACKFILL_ENABLED="true",
        ))
        enabled = resolve_realtime_feature_state(settings_with_env(
            CONTINUOUS_SQL_JOIN_ENABLED="true",
            LATEST_STATIC_PER_BATCH_ENABLED="true",
            STATIC_CHANGE_BACKFILL_ENABLED="true",
        ))

        self.assertFalse(disabled.latest_static_per_batch_enabled)
        self.assertFalse(disabled.static_change_backfill_enabled)
        self.assertTrue(enabled.latest_static_per_batch_enabled)
        self.assertTrue(enabled.static_change_backfill_enabled)

    def test_clickhouse_mode_requires_continuous_sql(self) -> None:
        disabled = resolve_realtime_feature_state(settings_with_env(
            CONTINUOUS_SQL_JOIN_ENABLED="false",
            CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
        ))
        enabled = resolve_realtime_feature_state(settings_with_env(
            CONTINUOUS_SQL_JOIN_ENABLED="true",
            CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
        ))

        self.assertFalse(disabled.clickhouse_continuous_join_enabled)
        self.assertTrue(enabled.clickhouse_continuous_join_enabled)

    def test_diagnostic_response_uses_resolved_state(self) -> None:
        configured = settings_with_env(
            DASHBOARD_SYNC_MODE="hybrid",
            REALTIME_EVENTS_ENABLED="true",
            CONTINUOUS_SQL_JOIN_ENABLED="true",
            CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
        )
        actor = ActorContext(name="config-reader", role="viewer")

        with patch("app.api.realtime.settings", configured):
            response = get_realtime_feature_config(actor)

        self.assertEqual(response.dashboard_sync_mode, "hybrid")
        self.assertTrue(response.realtime_events_enabled)
        self.assertTrue(response.continuous_sql_join_enabled)
        self.assertTrue(response.clickhouse_continuous_join_enabled)
        self.assertEqual(response.feature_scope, "deployment")


if __name__ == "__main__":
    unittest.main()
