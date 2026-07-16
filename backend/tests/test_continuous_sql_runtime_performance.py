import sys
from pathlib import Path
import unittest
from unittest.mock import patch

from app.core.config import Settings


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import continuous_sql_runtime as runtime  # noqa: E402


class FakeDuplicateFilter:
    def __init__(self, frame):
        self.frame = frame

    def where(self, _expression):
        return self

    def limit(self, _limit):
        return self

    def count(self):
        self.frame.uniqueness_actions += 1
        return self.frame.duplicate_count


class FakeGroupedFrame:
    def __init__(self, frame):
        self.frame = frame

    def count(self):
        return FakeDuplicateFilter(self.frame)


class FakeStaticFrame:
    def __init__(self, snapshot_id, *, duplicate_count=0):
        self.snapshot_id = snapshot_id
        self.duplicate_count = duplicate_count
        self.cache_calls = 0
        self.unpersist_calls = 0
        self.uniqueness_actions = 0

    def cache(self):
        self.cache_calls += 1
        return self

    def unpersist(self, *, blocking=False):
        del blocking
        self.unpersist_calls += 1

    def groupBy(self, *_keys):
        return FakeGroupedFrame(self)


def static_relation(*, cache_hint=True, broadcast_hint=False):
    return {
        "alias": "users",
        "broadcastHint": broadcast_hint,
        "cacheHint": cache_hint,
        "datasetId": "dataset-users",
        "mode": "static",
        "queryEngineTable": {
            "catalog": "iceberg",
            "schema": "asklake",
            "table": "users",
        },
        "schemaFingerprint": "users-schema",
    }


def static_binding(snapshot_id):
    return {
        "datasetId": "dataset-users",
        "schemaFingerprint": "users-schema",
        "snapshotId": str(snapshot_id),
    }


PLAN = {
    "joins": [{
        "rightAlias": "users",
        "keys": [{"rightColumn": "id"}],
    }],
}


class ContinuousSqlRuntimePerformanceTests(unittest.TestCase):
    def setUp(self):
        runtime.reset_static_snapshot_cache()

    def tearDown(self):
        runtime.reset_static_snapshot_cache()

    def test_reuses_cached_frame_and_uniqueness_check_for_immutable_snapshot(self):
        frames = {}

        def load_snapshot(_spark, _mapping, snapshot_id):
            frame = FakeStaticFrame(snapshot_id)
            frames.setdefault(snapshot_id, []).append(frame)
            return frame

        relation = static_relation()
        binding = static_binding("101")
        with patch.object(runtime, "read_static_snapshot", side_effect=load_snapshot):
            first = runtime.reusable_static_snapshot(object(), relation, binding)
            second = runtime.reusable_static_snapshot(object(), relation, binding)
            runtime.verify_static_key_uniqueness(first, relation, PLAN, binding)
            runtime.verify_static_key_uniqueness(second, relation, PLAN, binding)

        self.assertIs(first, second)
        self.assertEqual(len(frames["101"]), 1)
        self.assertEqual(first.cache_calls, 1)
        self.assertEqual(first.uniqueness_actions, 1)

    def test_new_snapshot_evicts_previous_frame_and_rechecks_uniqueness(self):
        loaded = []

        def load_snapshot(_spark, _mapping, snapshot_id):
            frame = FakeStaticFrame(snapshot_id)
            loaded.append(frame)
            return frame

        relation = static_relation()
        first_binding = static_binding("101")
        second_binding = static_binding("102")
        with patch.object(runtime, "read_static_snapshot", side_effect=load_snapshot):
            first = runtime.reusable_static_snapshot(object(), relation, first_binding)
            runtime.verify_static_key_uniqueness(first, relation, PLAN, first_binding)
            second = runtime.reusable_static_snapshot(object(), relation, second_binding)
            runtime.verify_static_key_uniqueness(second, relation, PLAN, second_binding)

        self.assertEqual(len(loaded), 2)
        self.assertEqual(first.unpersist_calls, 1)
        self.assertEqual(second.uniqueness_actions, 1)

    def test_cache_disabled_frame_checks_once_and_discards_old_snapshot_identity(self):
        loaded = []

        def load_snapshot(_spark, _mapping, snapshot_id):
            frame = FakeStaticFrame(snapshot_id)
            loaded.append(frame)
            return frame

        relation = static_relation(cache_hint=False, broadcast_hint=True)
        first_binding = static_binding("101")
        second_binding = static_binding("102")
        with patch.object(runtime, "read_static_snapshot", side_effect=load_snapshot):
            first = runtime.reusable_static_snapshot(object(), relation, first_binding)
            first_retry = runtime.reusable_static_snapshot(object(), relation, first_binding)
            runtime.verify_static_key_uniqueness(first, relation, PLAN, first_binding)
            runtime.verify_static_key_uniqueness(first_retry, relation, PLAN, first_binding)
            second = runtime.reusable_static_snapshot(object(), relation, second_binding)
            runtime.verify_static_key_uniqueness(second, relation, PLAN, second_binding)

        self.assertEqual(len(loaded), 3)
        self.assertEqual(sum(frame.cache_calls for frame in loaded), 0)
        self.assertEqual(first.uniqueness_actions, 1)
        self.assertEqual(first_retry.uniqueness_actions, 0)
        self.assertEqual(second.uniqueness_actions, 1)
        self.assertEqual(len(runtime._VERIFIED_STATIC_KEYS), 1)

    def test_continuous_output_adds_internal_run_partition_without_duplicates(self):
        self.assertEqual(
            runtime.continuous_output_partition_columns(["event_date"], PLAN),
            ["event_date", "_asklake_run_id"],
        )
        self.assertEqual(
            runtime.continuous_output_partition_columns(
                ["event_date", "_ASKLAKE_RUN_ID"],
                PLAN,
            ),
            ["event_date", "_ASKLAKE_RUN_ID"],
        )
        self.assertEqual(
            runtime.continuous_output_partition_columns(["event_date"], {}),
            ["event_date"],
        )
        worker_source = (SCRIPTS_DIR / "kafka_continuous_stream.py").read_text(encoding="utf-8")
        self.assertIn(
            "partition_columns=continuous_output_partition_columns(",
            worker_source,
        )

    def test_static_cache_limit_is_checked_in_and_forwarded_to_production(self):
        self.assertEqual(
            Settings.model_fields["continuous_sql_static_cache_max_rows"].default,
            5_000_000,
        )
        for relative_path in ("backend/.env.example", "deploy/.env.example"):
            with self.subTest(relative_path=relative_path):
                contents = (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")
                self.assertIn("CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS=5000000\n", contents)
        compose = (REPOSITORY_ROOT / "deploy/docker-compose.prod.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS: "
            "${CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS:-5000000}",
            compose,
        )


if __name__ == "__main__":
    unittest.main()
