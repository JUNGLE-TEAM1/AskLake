import importlib.util
from pathlib import Path
import unittest


def load_verifier_module():
    script = Path(__file__).resolve().parents[1] / "scripts" / "verify-kafka-continuous-iceberg.py"
    spec = importlib.util.spec_from_file_location("asklake_continuous_iceberg_verifier", script)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the Kafka Continuous Iceberg verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFIER = load_verifier_module()


class KafkaContinuousOperationalHarnessTests(unittest.TestCase):
    def probe(self, counts, errors=None):
        probe = VERIFIER.ConcurrentReadProbe(None, {})
        probe.counts = list(counts)
        probe.errors = list(errors or [])
        return probe

    def test_atomic_append_allows_only_before_or_after_snapshot_counts(self) -> None:
        self.probe([7, 7, 9, 9]).assert_atomic_append(7, 9)

    def test_atomic_append_rejects_partial_commit_visibility(self) -> None:
        with self.assertRaises(AssertionError):
            self.probe([7, 8, 9]).assert_atomic_append(7, 9)

    def test_atomic_append_rejects_row_count_regression(self) -> None:
        with self.assertRaises(AssertionError):
            self.probe([9, 7]).assert_atomic_append(7, 9)

    def test_atomic_append_surfaces_trino_errors(self) -> None:
        with self.assertRaises(AssertionError):
            self.probe([], ["query failed"]).assert_atomic_append(7, 9)

    def test_time_travel_table_identifier_quotes_metadata_suffix(self) -> None:
        target = {"catalog": "iceberg", "namespace": "asklake", "table": "reviews"}
        self.assertEqual(
            VERIFIER.qualified_table(target, suffix="$refs"),
            '"iceberg"."asklake"."reviews$refs"',
        )


if __name__ == "__main__":
    unittest.main()
