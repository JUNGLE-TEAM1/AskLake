from __future__ import annotations

import unittest

from app.services.continuous_sql_catalog import ContinuousSqlCatalogResolver
from app.services.continuous_sql_planner import ContinuousSqlValidationError


class ContinuousSqlCatalogResolverTests(unittest.TestCase):
    def test_v2_stream_accepts_active_clickhouse_binding_without_iceberg(self) -> None:
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.allow_clickhouse_streaming = True
        payload = {
            "storageFormat": "clickhouse",
            "queryEngineStatus": "unavailable",
            "clickhouseTable": {
                "database": "asklake_realtime_v2",
                "table": "raw_events_v2_current",
            },
            "physicalBindings": [{
                "role": "serving",
                "engine": "clickhouse",
                "status": "active",
                "database": "asklake_realtime_v2",
                "table": "raw_events_v2_current",
            }],
        }

        mapping = resolver._relation_mapping(payload, "ds_stream", "streaming")

        self.assertEqual(mapping["format"], "clickhouse")
        self.assertEqual(mapping["schema"], "asklake_realtime_v2")
        self.assertEqual(mapping["table"], "raw_events_v2_current")

    def test_v2_stream_rejects_pending_clickhouse_binding(self) -> None:
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.allow_clickhouse_streaming = True
        payload = {
            "storageFormat": "clickhouse",
            "clickhouseTable": {"database": "asklake_realtime_v2", "table": "raw_events_v2_current"},
            "physicalBindings": [{
                "role": "serving",
                "engine": "clickhouse",
                "status": "pending",
                "database": "asklake_realtime_v2",
                "table": "raw_events_v2_current",
            }],
        }

        with self.assertRaises(ContinuousSqlValidationError) as raised:
            resolver._relation_mapping(payload, "ds_stream", "streaming")

        self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_STREAM_NOT_CLICKHOUSE_BOUND")

    def test_static_relation_still_requires_available_iceberg_mapping(self) -> None:
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.allow_clickhouse_streaming = True

        with self.assertRaises(ContinuousSqlValidationError) as raised:
            resolver._relation_mapping({"queryEngineStatus": "unavailable"}, "ds_static", "static")

        self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_RELATION_NOT_QUERYABLE")


if __name__ == "__main__":
    unittest.main()
