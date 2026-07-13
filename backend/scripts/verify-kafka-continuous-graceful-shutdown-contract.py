from __future__ import annotations

import ast
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STREAM = ROOT / "scripts" / "kafka_continuous_stream.py"
MANAGER = ROOT / "scripts" / "manage-kafka-continuous.mjs"


def main() -> None:
    source = STREAM.read_text(encoding="utf-8")
    ast.parse(source)
    signal_body = source[source.index("def on_signal"):source.index("def test_batch_delay")]
    assert "QUERY.stop" not in signal_body, "Signal handlers must only record stop intent."
    assert not re.search(r"if\s+STOP_REQUESTED\s*:\s*\n\s+return", source), (
        "A stop request must never make foreachBatch return successfully before publishing the batch."
    )
    assert "finally:\n            for frame in reversed(persisted_frames):" in source
    assert "if STOP_REQUESTED and QUERY.isActive:" in source
    assert source.index("write_batch_manifest(") < source.index('report("running", batch_id=batch_id)', source.index("def write_persisted_batch"))
    assert 'test_batch_delay("batch_started")' in source
    assert 'test_batch_delay("after_data_write")' in source
    assert "def batch_input_metrics" in source
    assert 'percentile_approx("latency_ms", [0.5, 0.95, 0.99], 10_000)' in source
    assert '"method": "kafka-record-timestamp-to-target-commit"' in source
    assert "def merge_latency_summary" in source
    assert '"aggregation": "worst-successful-batch-percentile"' in source
    assert 'raw_last_included_batch_id = existing.get("lastIncludedBatchId")' in source
    assert '"endToEndLatency": end_to_end_latency' in source
    latency_commit = source.index("end_to_end_latency = committed_latency_metrics")
    assert source.index('test_batch_delay("after_data_write")') < latency_commit
    assert latency_commit < source.index("write_batch_manifest(", latency_commit)

    manager = MANAGER.read_text(encoding="utf-8")
    assert 'String(process.env.APP_ENV || "").trim().toLowerCase() === "production"' in manager
    assert 'ASKLAKE_CONTINUOUS_TEST_MODE: testMode' in manager
    print("verify-kafka-continuous-graceful-shutdown-contract: ok")


if __name__ == "__main__":
    main()
