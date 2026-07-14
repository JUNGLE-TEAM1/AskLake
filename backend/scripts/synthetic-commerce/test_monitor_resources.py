#!/usr/bin/env python3

from __future__ import annotations

import csv
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("monitor_resources.py")
SPEC = importlib.util.spec_from_file_location("synthetic_monitor_resources", MODULE_PATH)
assert SPEC and SPEC.loader
monitor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = monitor
SPEC.loader.exec_module(monitor)


DOCKER_STATS = json.dumps(
    {
        "BlockIO": "12.5MB / 2KiB",
        "CPUPerc": "17.25%",
        "MemUsage": "512MiB / 2GiB",
        "NetIO": "1.5kB / 2MB",
        "PIDs": "14",
    }
)


class ParsingTests(unittest.TestCase):
    def test_parse_size_bytes_supports_decimal_and_iec_units(self) -> None:
        self.assertEqual(monitor.parse_size_bytes("1.5kB"), 1500)
        self.assertEqual(monitor.parse_size_bytes("1.5 KiB"), 1536)
        self.assertEqual(monitor.parse_size_bytes("2GB"), 2_000_000_000)
        self.assertEqual(monitor.parse_size_bytes("2GiB"), 2 * 1024**3)
        self.assertEqual(monitor.parse_size_bytes("0B"), 0)

    def test_parse_size_bytes_rejects_unknown_or_negative_values(self) -> None:
        for value in ("N/A", "-1MB", "12XB", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                monitor.parse_size_bytes(value)

    def test_parse_docker_stats_maps_all_required_metrics(self) -> None:
        sample = monitor.parse_docker_stats(
            DOCKER_STATS, "spark-worker", "2026-07-13T00:00:00.000Z"
        )

        self.assertEqual(sample.container_name, "spark-worker")
        self.assertEqual(sample.cpu_pct, 17.25)
        self.assertEqual(sample.memory_used_bytes, 512 * 1024**2)
        self.assertEqual(sample.memory_limit_bytes, 2 * 1024**3)
        self.assertEqual(sample.block_read_bytes, 12_500_000)
        self.assertEqual(sample.block_write_bytes, 2048)
        self.assertEqual(sample.network_rx_bytes, 1500)
        self.assertEqual(sample.network_tx_bytes, 2_000_000)
        self.assertEqual(sample.pids, 14)
        self.assertEqual(sample.sample_error, "")

    def test_collect_container_sample_turns_missing_docker_into_error_row(self) -> None:
        def missing_runner(*_args, **_kwargs):
            raise FileNotFoundError("docker")

        sample = monitor.collect_container_sample(
            "missing", "2026-07-13T00:00:00.000Z", runner=missing_runner
        )

        self.assertEqual(sample.container_name, "missing")
        self.assertIn("docker", sample.sample_error)
        self.assertIsNone(sample.cpu_pct)

    def test_collect_container_sample_turns_cli_failure_into_error_row(self) -> None:
        def failed_runner(*_args, **_kwargs):
            return subprocess.CompletedProcess(
                args=["docker", "stats"],
                returncode=1,
                stdout="",
                stderr="No such container: gone\n",
            )

        sample = monitor.collect_container_sample(
            "gone", "2026-07-13T00:00:00.000Z", runner=failed_runner
        )

        self.assertEqual(sample.sample_error, "No such container: gone")

    def test_collect_container_sample_turns_malformed_stats_into_error_row(self) -> None:
        def malformed_runner(*_args, **_kwargs):
            return subprocess.CompletedProcess(
                args=["docker", "stats"],
                returncode=0,
                stdout='{"CPUPerc":"1%"}\n',
                stderr="",
            )

        sample = monitor.collect_container_sample(
            "broken", "2026-07-13T00:00:00.000Z", runner=malformed_runner
        )

        self.assertIn("MemUsage", sample.sample_error)

    def test_container_identifier_rejects_blank_or_path_values(self) -> None:
        for value in ("", "../spark-worker", "spark worker"):
            with self.subTest(value=value), self.assertRaises(
                monitor.argparse.ArgumentTypeError
            ):
                monitor.container_identifier(value)

    def test_linux_host_collector_calculates_cpu_and_memory(self) -> None:
        snapshots = iter(
            [
                monitor.HostSnapshot(100, 40, 1_000, 300, 10, 20, 30, 40, 5),
                monitor.HostSnapshot(200, 70, 1_000, 250, 11, 22, 33, 44, 6),
            ]
        )
        collector = monitor.LinuxHostCollector(reader=lambda: next(snapshots))

        first = collector("2026-07-13T00:00:00.000Z")
        second = collector("2026-07-13T00:00:05.000Z")

        self.assertEqual(first.container_name, monitor.HOST_RESOURCE_NAME)
        self.assertIsNone(first.cpu_pct)
        self.assertEqual(first.memory_used_bytes, 700)
        self.assertEqual(second.cpu_pct, 70.0)
        self.assertEqual(second.memory_used_bytes, 750)
        self.assertEqual(second.network_tx_bytes, 44)

    def test_read_linux_host_snapshot_parses_proc_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc / "stat").write_text(
                "cpu  10 2 3 40 5 1 1 0 0 0\n", encoding="utf-8"
            )
            (proc / "meminfo").write_text(
                "MemTotal:       1000 kB\nMemAvailable:    250 kB\n",
                encoding="utf-8",
            )
            (proc / "diskstats").write_text(
                "259 0 nvme0n1 1 0 10 0 2 0 20 0 0 0 0 0 0 0 0\n"
                "259 1 nvme0n1p1 1 0 999 0 2 0 999 0 0 0 0 0 0 0 0\n",
                encoding="utf-8",
            )
            (proc / "net").mkdir()
            (proc / "net/dev").write_text(
                "Inter-| Receive | Transmit\n"
                " face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n"
                "    lo: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n"
                "  eth0: 300 0 0 0 0 0 0 0 400 0 0 0 0 0 0 0\n",
                encoding="utf-8",
            )
            (proc / "1").mkdir()
            (proc / "22").mkdir()

            snapshot = monitor.read_linux_host_snapshot(proc)

        self.assertEqual(snapshot.cpu_total_ticks, 62)
        self.assertEqual(snapshot.cpu_idle_ticks, 45)
        self.assertEqual(snapshot.memory_total_bytes, 1_024_000)
        self.assertEqual(snapshot.memory_available_bytes, 256_000)
        self.assertEqual(snapshot.block_read_bytes, 5120)
        self.assertEqual(snapshot.block_write_bytes, 10240)
        self.assertEqual(snapshot.network_rx_bytes, 300)
        self.assertEqual(snapshot.network_tx_bytes, 400)
        self.assertEqual(snapshot.pids, 2)


class SamplerTests(unittest.TestCase):
    def test_metadata_file_requires_an_object(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.json"
            path.write_text('["not", "an", "object"]', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "must contain an object"):
                monitor.load_metadata_file(path)

    def test_sampler_finalizes_all_artifacts_with_per_container_errors(self) -> None:
        clock_values = iter(
            [
                100.0,
                100.0,
                100.2,
                100.2,
            ]
        )
        wall_values = iter(
            [
                datetime(2026, 7, 13, tzinfo=timezone.utc),
                datetime(2026, 7, 13, tzinfo=timezone.utc),
                datetime(2026, 7, 13, tzinfo=timezone.utc) + timedelta(milliseconds=200),
            ]
        )

        def collector(container_name: str, timestamp: str):
            if container_name == "gone":
                return monitor.ContainerSample(
                    timestamp=timestamp,
                    container_name=container_name,
                    sample_error="No such container: gone",
                )
            return monitor.parse_docker_stats(DOCKER_STATS, container_name, timestamp)

        def host_collector(timestamp: str):
            return monitor.ContainerSample(
                timestamp=timestamp,
                container_name=monitor.HOST_RESOURCE_NAME,
                cpu_pct=20.0,
                memory_used_bytes=1024,
                memory_limit_bytes=4096,
                pids=20,
            )

        with tempfile.TemporaryDirectory() as directory, patch.object(
            monitor, "host_metadata", return_value={"vcpu_count": 2, "memory_total_bytes": 4096}
        ):
            summary = monitor.run_sampler(
                Path(directory),
                "experiment-1",
                ["spark-worker", "gone"],
                interval_seconds=5.0,
                duration_seconds=0.1,
                metadata={"job_id": "job-1", "input_bytes": 1_000_000_000},
                collector=collector,
                host_collector=host_collector,
                sleep=lambda _seconds: None,
                monotonic=lambda: next(clock_values),
                now=lambda: next(wall_values),
            )
            run_dir = Path(directory) / "experiment-1"

            experiment = json.loads(
                (run_dir / "experiment.json").read_text(encoding="utf-8")
            )
            saved_summary = json.loads(
                (run_dir / "summary.json").read_text(encoding="utf-8")
            )
            with (run_dir / "resource-samples.csv").open(
                "r", encoding="utf-8", newline=""
            ) as handle:
                rows = list(csv.DictReader(handle))

        self.assertEqual(summary, saved_summary)
        self.assertEqual(experiment["status"], "completed_with_errors")
        self.assertEqual(experiment["host"]["vcpu_count"], 2)
        self.assertEqual(experiment["context"]["job_id"], "job-1")
        self.assertEqual(summary["context"]["input_bytes"], 1_000_000_000)
        self.assertEqual(summary["sample_rows"], 3)
        self.assertEqual(summary["successful_samples"], 2)
        self.assertEqual(summary["error_samples"], 1)
        self.assertEqual(summary["host"]["max_cpu_pct"], 20.0)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["container_name"], monitor.HOST_RESOURCE_NAME)
        self.assertEqual(rows[1]["container_name"], "spark-worker")
        self.assertEqual(rows[1]["memory_used_bytes"], str(512 * 1024**2))
        self.assertEqual(rows[2]["container_name"], "gone")
        self.assertEqual(rows[2]["sample_error"], "No such container: gone")

    def test_keyboard_interrupt_still_writes_summary(self) -> None:
        def interrupting_collector(_container_name: str, _timestamp: str):
            raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as directory:
            summary = monitor.run_sampler(
                Path(directory),
                "experiment-interrupted",
                ["spark-worker"],
                interval_seconds=5.0,
                duration_seconds=None,
                collector=interrupting_collector,
                host_collector=lambda timestamp: monitor.ContainerSample(
                    timestamp=timestamp,
                    container_name=monitor.HOST_RESOURCE_NAME,
                ),
            )
            run_dir = Path(directory) / "experiment-interrupted"

            self.assertEqual(summary["status"], "interrupted")
            self.assertTrue((run_dir / "experiment.json").is_file())
            self.assertTrue((run_dir / "resource-samples.csv").is_file())
            self.assertTrue((run_dir / "summary.json").is_file())

    def test_existing_experiment_directory_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "experiment-1"
            run_dir.mkdir()
            marker = run_dir / "keep.txt"
            marker.write_text("existing evidence", encoding="utf-8")

            with self.assertRaises(FileExistsError):
                monitor.run_sampler(
                    Path(directory),
                    "experiment-1",
                    ["spark-worker"],
                    interval_seconds=5.0,
                    duration_seconds=0.1,
                )
            self.assertEqual(marker.read_text(encoding="utf-8"), "existing evidence")


if __name__ == "__main__":
    unittest.main()
