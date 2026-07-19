import json
import os
import unittest
from unittest.mock import Mock, patch

from fastapi import Response

from app.api.health import realtime_health_check
from app.api.realtime import get_realtime_feature_config
from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.services.realtime_feature_flags import (
    RealtimeConsumerOwnershipError,
    resolve_realtime_feature_state,
    validate_clickhouse_consumer_ownership,
)
from app.realtime.infrastructure.kafka_connect_gateway import ConnectorProbe


REALTIME_ENV_KEYS = {
    "DASHBOARD_SYNC_MODE",
    "REALTIME_EVENTS_ENABLED",
    "CONTINUOUS_SQL_JOIN_ENABLED",
    "CLICKHOUSE_CONTINUOUS_JOIN_ENABLED",
    "CLICKHOUSE_REALTIME_V2_ENABLED",
    "KAFKA_CONNECT_SINK_ENABLED",
    "CLICKHOUSE_REALTIME_CONSUMER_OWNER",
    "KAFKA_CONNECT_URL",
    "KAFKA_CONNECT_CONNECTOR_NAME",
    "CLICKHOUSE_V2_URL",
    "CLICKHOUSE_V2_DATABASE",
    "CLICKHOUSE_V2_MATERIALIZER_USER",
    "CLICKHOUSE_V2_MATERIALIZER_PASSWORD",
    "CLICKHOUSE_V2_READER_USER",
    "CLICKHOUSE_V2_READER_PASSWORD",
    "CLICKHOUSE_V2_TLS_CA_FILE",
    "LATEST_STATIC_PER_BATCH_ENABLED",
    "STATIC_CHANGE_BACKFILL_ENABLED",
}


def settings_with_env(**values: str) -> Settings:
    environment = {key: value for key, value in os.environ.items() if key not in REALTIME_ENV_KEYS}
    environment.update(values)
    with patch.dict(os.environ, environment, clear=True):
        return Settings(app_env="test", _env_file=None)


class RealtimeFeatureFlagTests(unittest.TestCase):
    def test_defaults_preserve_polling_and_disable_new_runtime(self) -> None:
        state = resolve_realtime_feature_state(settings_with_env())

        self.assertEqual(state.dashboard_sync_mode, "polling")
        self.assertFalse(state.realtime_events_enabled)
        self.assertFalse(state.continuous_sql_join_enabled)
        self.assertFalse(state.clickhouse_continuous_join_enabled)
        self.assertFalse(state.clickhouse_realtime_v2_enabled)
        self.assertFalse(state.kafka_connect_sink_enabled)
        self.assertEqual(state.clickhouse_realtime_consumer_owner, "disabled")
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

    def test_existing_v1_flag_remains_valid_with_new_owner_disabled(self) -> None:
        configured = settings_with_env(
            CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
        )

        self.assertTrue(configured.clickhouse_continuous_join_enabled)
        self.assertEqual(configured.clickhouse_realtime_consumer_owner, "disabled")

    def test_kafka_connect_sink_requires_v2_and_explicit_owner(self) -> None:
        invalid_environments = (
            {
                "KAFKA_CONNECT_SINK_ENABLED": "true",
                "CLICKHOUSE_REALTIME_CONSUMER_OWNER": "kafka_connect_v2",
                "KAFKA_CONNECT_URL": "http://localhost:8083",
            },
            {
                "CLICKHOUSE_REALTIME_V2_ENABLED": "true",
                "KAFKA_CONNECT_SINK_ENABLED": "true",
                "KAFKA_CONNECT_URL": "http://localhost:8083",
            },
        )
        for environment in invalid_environments:
            with self.subTest(environment=environment):
                with self.assertRaises(ValueError):
                    settings_with_env(**environment)

    def test_kafka_connect_owner_rejects_v1_dual_ownership(self) -> None:
        with self.assertRaises(ValueError):
            settings_with_env(
                CLICKHOUSE_REALTIME_V2_ENABLED="true",
                KAFKA_CONNECT_SINK_ENABLED="true",
                CLICKHOUSE_REALTIME_CONSUMER_OWNER="kafka_connect_v2",
                KAFKA_CONNECT_URL="http://localhost:8083",
                CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
            )

    def test_kafka_engine_owner_requires_existing_v1_flag(self) -> None:
        with self.assertRaises(ValueError):
            settings_with_env(
                CLICKHOUSE_REALTIME_CONSUMER_OWNER="kafka_engine_v1",
            )

        with self.assertRaises(ValueError):
            settings_with_env(
                CLICKHOUSE_REALTIME_CONSUMER_OWNER="kafka_engine_v1",
                CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
            )

        configured = settings_with_env(
            CLICKHOUSE_REALTIME_CONSUMER_OWNER="kafka_engine_v1",
            CONTINUOUS_SQL_JOIN_ENABLED="true",
            CLICKHOUSE_CONTINUOUS_JOIN_ENABLED="true",
        )
        self.assertEqual(
            configured.clickhouse_realtime_consumer_owner,
            "kafka_engine_v1",
        )

    def test_valid_v2_connect_configuration_is_secret_free_in_health(self) -> None:
        configured = settings_with_env(
            CLICKHOUSE_REALTIME_V2_ENABLED="true",
            KAFKA_CONNECT_SINK_ENABLED="true",
            CLICKHOUSE_REALTIME_CONSUMER_OWNER="kafka_connect_v2",
            KAFKA_CONNECT_URL="http://connect.internal:8083",
            KAFKA_CONNECT_CONNECTOR_NAME="asklake-orders-v2",
            CLICKHOUSE_PASSWORD="never-return-this-clickhouse-secret",
        )
        response = Response()
        clickhouse = Mock()
        clickhouse.ping.return_value = True

        with (
            patch("app.api.health.settings", configured),
            patch(
                "app.api.health.RealtimeIngestService.probe",
                return_value=ConnectorProbe(True, False, "UNREGISTERED", ()),
            ),
            patch(
                "app.api.health.ClickHouseClient.realtime_v2_reader",
                return_value=clickhouse,
            ),
        ):
            payload = realtime_health_check(response)

        self.assertEqual(response.status_code, 503)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "not_ready")
        self.assertEqual(
            payload["v2"],
            {
                "enabled": True,
                "ready": True,
                "status": "ready",
                "consumerOwner": "kafka_connect_v2",
                "connector": {
                    "enabled": True,
                    "configured": True,
                    "state": "UNREGISTERED",
                    "taskStates": [],
                    "workerReady": True,
                },
                "clickhouse": {"ready": True},
            },
        )
        clickhouse.close.assert_called_once_with()
        encoded = json.dumps(payload)
        self.assertNotIn("connect.internal", encoded)
        self.assertNotIn("asklake-orders-v2", encoded)
        self.assertNotIn("never-return-this-clickhouse-secret", encoded)

    def test_connect_url_and_connector_identity_are_bounded(self) -> None:
        invalid_values = (
            {"KAFKA_CONNECT_URL": "http://user:secret@localhost:8083"},
            {"KAFKA_CONNECT_URL": "http://localhost:8083/connectors"},
            {"KAFKA_CONNECT_URL": "http://localhost:8083?token=secret"},
            {"KAFKA_CONNECT_URL": f"http://{'a' * 2_048}.invalid"},
            {"KAFKA_CONNECT_CONNECTOR_NAME": "invalid connector name"},
            {"KAFKA_CONNECT_CONNECTOR_NAME": "x" * 129},
            {"KAFKA_CONNECT_CONNECTOR_NAME": "replace-with-connector"},
        )
        for environment in invalid_values:
            with self.subTest(environment=environment):
                with self.assertRaises(ValueError):
                    settings_with_env(**environment)

        secret_url = "http://user:do-not-log-this-secret@localhost:8083"
        with self.assertRaises(ValueError) as caught:
            settings_with_env(KAFKA_CONNECT_URL=secret_url)
        self.assertNotIn(secret_url, str(caught.exception))
        self.assertNotIn("do-not-log-this-secret", str(caught.exception))

    def test_generation_guard_rejects_dual_or_mismatched_owner_claims(self) -> None:
        with self.assertRaises(RealtimeConsumerOwnershipError):
            validate_clickhouse_consumer_ownership(
                job_id="csql-orders",
                generation=3,
                configured_owner="kafka_connect_v2",
                claimed_owners=("kafka_engine_v1", "kafka_connect_v2"),
            )
        with self.assertRaises(RealtimeConsumerOwnershipError):
            validate_clickhouse_consumer_ownership(
                job_id="csql-orders",
                generation=3,
                configured_owner="disabled",
                claimed_owners=("kafka_engine_v1",),
            )

        owner = validate_clickhouse_consumer_ownership(
            job_id="csql-orders",
            generation=3,
            configured_owner="kafka_connect_v2",
            claimed_owners=("kafka_connect_v2", "kafka_connect_v2"),
        )
        self.assertEqual(owner, "kafka_connect_v2")

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
        self.assertFalse(response.clickhouse_realtime_v2_enabled)
        self.assertFalse(response.kafka_connect_sink_enabled)
        self.assertEqual(response.clickhouse_realtime_consumer_owner, "disabled")
        self.assertEqual(response.feature_scope, "deployment")


if __name__ == "__main__":
    unittest.main()
