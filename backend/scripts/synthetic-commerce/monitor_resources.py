#!/usr/bin/env python3
"""Sample Linux host and Docker container resource usage for an experiment."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import platform
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence


SCHEMA_VERSION = 1
DOCKER_TIMEOUT_SECONDS = 15.0
CSV_FIELDS = (
    "timestamp",
    "container_name",
    "cpu_pct",
    "memory_used_bytes",
    "memory_limit_bytes",
    "block_read_bytes",
    "block_write_bytes",
    "network_rx_bytes",
    "network_tx_bytes",
    "pids",
    "sample_error",
)

SIZE_PATTERN = re.compile(
    r"^(?P<number>(?:\d+(?:\.\d*)?|\.\d+))\s*(?P<unit>[kmgtpe]?i?b)?$",
    re.IGNORECASE,
)
SIZE_FACTORS = {
    "": 1,
    "b": 1,
    "kb": 1000,
    "mb": 1000**2,
    "gb": 1000**3,
    "tb": 1000**4,
    "pb": 1000**5,
    "eb": 1000**6,
    "kib": 1024,
    "mib": 1024**2,
    "gib": 1024**3,
    "tib": 1024**4,
    "pib": 1024**5,
    "eib": 1024**6,
}


@dataclass(frozen=True)
class ContainerSample:
    timestamp: str
    container_name: str
    cpu_pct: float | None = None
    memory_used_bytes: int | None = None
    memory_limit_bytes: int | None = None
    block_read_bytes: int | None = None
    block_write_bytes: int | None = None
    network_rx_bytes: int | None = None
    network_tx_bytes: int | None = None
    pids: int | None = None
    sample_error: str = ""

    def as_csv_row(self) -> dict[str, object | None]:
        return {field: getattr(self, field) for field in CSV_FIELDS}


@dataclass(frozen=True)
class HostSnapshot:
    cpu_total_ticks: int
    cpu_idle_ticks: int
    memory_total_bytes: int
    memory_available_bytes: int
    block_read_bytes: int
    block_write_bytes: int
    network_rx_bytes: int
    network_tx_bytes: int
    pids: int


HOST_RESOURCE_NAME = "__host__"
WHOLE_DISK_PATTERN = re.compile(
    r"^(?:nvme\d+n\d+|xvd[a-z]+|sd[a-z]+|vd[a-z]+|md\d+)$"
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number") from exc
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def experiment_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise argparse.ArgumentTypeError(
            "must start with an alphanumeric character and contain only letters, "
            "numbers, '.', '_' or '-'"
        )
    return value


def container_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value):
        raise argparse.ArgumentTypeError(
            "must start with an alphanumeric character and contain only letters, "
            "numbers, '.', '_' or '-'"
        )
    return value


def parse_size_bytes(value: str) -> int:
    """Parse Docker's decimal and IEC human-readable sizes into bytes."""
    match = SIZE_PATTERN.fullmatch(value.strip())
    if not match:
        raise ValueError(f"invalid byte size: {value!r}")
    number = float(match.group("number"))
    unit = (match.group("unit") or "").lower()
    return int(number * SIZE_FACTORS[unit])


def parse_pair(value: str, label: str) -> tuple[int, int]:
    parts = re.split(r"\s*/\s*", value.strip(), maxsplit=1)
    if len(parts) != 2:
        raise ValueError(f"invalid {label}: {value!r}")
    return parse_size_bytes(parts[0]), parse_size_bytes(parts[1])


def parse_percentage(value: str) -> float:
    stripped = value.strip()
    if not stripped.endswith("%"):
        raise ValueError(f"invalid percentage: {value!r}")
    parsed = float(stripped[:-1])
    if not math.isfinite(parsed) or parsed < 0:
        raise ValueError(f"invalid percentage: {value!r}")
    return parsed


def parse_docker_stats(
    payload: str, container_name: str, timestamp: str
) -> ContainerSample:
    """Convert one ``docker stats --format '{{json .}}'`` row to a sample."""
    lines = [line for line in payload.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError(f"expected one Docker stats row, received {len(lines)}")

    raw = json.loads(lines[0])
    if not isinstance(raw, dict):
        raise ValueError("Docker stats row must be a JSON object")

    memory_used, memory_limit = parse_pair(str(raw["MemUsage"]), "memory usage")
    block_read, block_write = parse_pair(str(raw["BlockIO"]), "block I/O")
    network_rx, network_tx = parse_pair(str(raw["NetIO"]), "network I/O")
    pids = int(str(raw["PIDs"]).strip())
    if pids < 0:
        raise ValueError(f"invalid PID count: {pids}")

    return ContainerSample(
        timestamp=timestamp,
        container_name=container_name,
        cpu_pct=parse_percentage(str(raw["CPUPerc"])),
        memory_used_bytes=memory_used,
        memory_limit_bytes=memory_limit,
        block_read_bytes=block_read,
        block_write_bytes=block_write,
        network_rx_bytes=network_rx,
        network_tx_bytes=network_tx,
        pids=pids,
    )


def normalize_error(value: object) -> str:
    message = " ".join(str(value).split())
    return message[:1000] or "unknown Docker sampling error"


RunCommand = Callable[..., subprocess.CompletedProcess[str]]


def collect_container_sample(
    container_name: str,
    timestamp: str,
    *,
    runner: RunCommand = subprocess.run,
) -> ContainerSample:
    command = [
        "docker",
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        container_name,
    ]
    try:
        result = runner(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_TIMEOUT_SECONDS,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise RuntimeError(detail or f"docker stats exited with {result.returncode}")
        return parse_docker_stats(result.stdout, container_name, timestamp)
    except (
        OSError,
        subprocess.SubprocessError,
        RuntimeError,
        ValueError,
        TypeError,
        KeyError,
        OverflowError,
    ) as exc:
        return ContainerSample(
            timestamp=timestamp,
            container_name=container_name,
            sample_error=normalize_error(exc),
        )


def read_linux_host_snapshot(proc_root: Path = Path("/proc")) -> HostSnapshot:
    cpu_parts = (proc_root / "stat").read_text(encoding="utf-8").splitlines()[0].split()
    if not cpu_parts or cpu_parts[0] != "cpu" or len(cpu_parts) < 5:
        raise ValueError("/proc/stat has no aggregate CPU row")
    cpu_values = [int(value) for value in cpu_parts[1:]]
    cpu_total = sum(cpu_values)
    cpu_idle = cpu_values[3] + (cpu_values[4] if len(cpu_values) > 4 else 0)

    memory: dict[str, int] = {}
    for line in (proc_root / "meminfo").read_text(encoding="utf-8").splitlines():
        key, separator, remainder = line.partition(":")
        if separator and remainder.split():
            memory[key] = int(remainder.split()[0]) * 1024
    memory_total = memory["MemTotal"]
    memory_available = memory.get("MemAvailable", memory.get("MemFree", 0))

    block_read = 0
    block_write = 0
    for line in (proc_root / "diskstats").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) < 10 or not WHOLE_DISK_PATTERN.fullmatch(parts[2]):
            continue
        block_read += int(parts[5]) * 512
        block_write += int(parts[9]) * 512

    network_rx = 0
    network_tx = 0
    for line in (proc_root / "net/dev").read_text(encoding="utf-8").splitlines()[2:]:
        interface, separator, counters = line.partition(":")
        if not separator or interface.strip() == "lo":
            continue
        values = counters.split()
        if len(values) < 9:
            raise ValueError("/proc/net/dev has a malformed interface row")
        network_rx += int(values[0])
        network_tx += int(values[8])

    pids = sum(1 for path in proc_root.iterdir() if path.name.isdigit())
    return HostSnapshot(
        cpu_total_ticks=cpu_total,
        cpu_idle_ticks=cpu_idle,
        memory_total_bytes=memory_total,
        memory_available_bytes=memory_available,
        block_read_bytes=block_read,
        block_write_bytes=block_write,
        network_rx_bytes=network_rx,
        network_tx_bytes=network_tx,
        pids=pids,
    )


class LinuxHostCollector:
    def __init__(self, reader: Callable[[], HostSnapshot] = read_linux_host_snapshot):
        self.reader = reader
        self.previous: HostSnapshot | None = None

    def __call__(self, timestamp: str) -> ContainerSample:
        try:
            current = self.reader()
            cpu_pct: float | None = None
            if self.previous is not None:
                total_delta = current.cpu_total_ticks - self.previous.cpu_total_ticks
                idle_delta = current.cpu_idle_ticks - self.previous.cpu_idle_ticks
                if total_delta <= 0 or idle_delta < 0:
                    raise ValueError("host CPU counters did not move forwards")
                cpu_pct = round(100.0 * (total_delta - idle_delta) / total_delta, 3)
            self.previous = current
            return ContainerSample(
                timestamp=timestamp,
                container_name=HOST_RESOURCE_NAME,
                cpu_pct=cpu_pct,
                memory_used_bytes=max(
                    0, current.memory_total_bytes - current.memory_available_bytes
                ),
                memory_limit_bytes=current.memory_total_bytes,
                block_read_bytes=current.block_read_bytes,
                block_write_bytes=current.block_write_bytes,
                network_rx_bytes=current.network_rx_bytes,
                network_tx_bytes=current.network_tx_bytes,
                pids=current.pids,
            )
        except (OSError, ValueError, IndexError, KeyError) as exc:
            return ContainerSample(
                timestamp=timestamp,
                container_name=HOST_RESOURCE_NAME,
                sample_error=normalize_error(exc),
            )


def total_memory_bytes() -> int | None:
    """Return host physical memory using portable stdlib facilities when available."""
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
        if page_size > 0 and page_count > 0:
            return int(page_size * page_count)
    except (AttributeError, OSError, ValueError):
        pass

    meminfo = Path("/proc/meminfo")
    try:
        for line in meminfo.read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def host_metadata() -> dict[str, object | None]:
    return {
        "vcpu_count": os.cpu_count(),
        "memory_total_bytes": total_memory_bytes(),
        "hostname": platform.node(),
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "platform": platform.platform(),
        "python_version": platform.python_version(),
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def empty_container_summary() -> dict[str, object | None]:
    return {
        "sample_rows": 0,
        "successful_samples": 0,
        "error_samples": 0,
        "max_cpu_pct": None,
        "max_memory_used_bytes": None,
        "last_error": None,
    }


def update_container_summary(
    summary: dict[str, object | None], sample: ContainerSample
) -> None:
    summary["sample_rows"] = int(summary["sample_rows"] or 0) + 1
    if sample.sample_error:
        summary["error_samples"] = int(summary["error_samples"] or 0) + 1
        summary["last_error"] = sample.sample_error
        return

    summary["successful_samples"] = int(summary["successful_samples"] or 0) + 1
    current_cpu = summary["max_cpu_pct"]
    current_memory = summary["max_memory_used_bytes"]
    summary["max_cpu_pct"] = max(
        float(current_cpu) if current_cpu is not None else 0.0,
        sample.cpu_pct or 0.0,
    )
    summary["max_memory_used_bytes"] = max(
        int(current_memory) if current_memory is not None else 0,
        sample.memory_used_bytes or 0,
    )


def run_sampler(
    output_root: Path,
    experiment: str,
    containers: Sequence[str],
    interval_seconds: float,
    duration_seconds: float | None,
    metadata: dict[str, Any] | None = None,
    *,
    collector: Callable[[str, str], ContainerSample] = collect_container_sample,
    host_collector: Callable[[str], ContainerSample] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    now: Callable[[], datetime] = utc_now,
) -> dict[str, Any]:
    if not containers:
        raise ValueError("at least one container is required")
    normalized_containers = list(
        dict.fromkeys(container_identifier(name) for name in containers)
    )
    collect_host = host_collector or LinuxHostCollector()

    run_directory = output_root / experiment
    run_directory.mkdir(parents=True, exist_ok=False)

    started_at = now()
    started_monotonic = monotonic()
    experiment_payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "experiment_id": experiment,
        "status": "running",
        "started_at": isoformat_utc(started_at),
        "finished_at": None,
        "sampler_interval_seconds": interval_seconds,
        "requested_duration_seconds": duration_seconds,
        "containers": normalized_containers,
        "host_resource_name": HOST_RESOURCE_NAME,
        "host": host_metadata(),
        "context": metadata or {},
    }
    write_json_atomic(run_directory / "experiment.json", experiment_payload)

    resource_summaries = {
        name: empty_container_summary()
        for name in [HOST_RESOURCE_NAME, *normalized_containers]
    }
    interrupted = False
    samples_path = run_directory / "resource-samples.csv"

    try:
        with samples_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            writer.writeheader()
            handle.flush()

            while True:
                timestamp = isoformat_utc(now())
                host_sample = collect_host(timestamp)
                writer.writerow(host_sample.as_csv_row())
                update_container_summary(
                    resource_summaries[HOST_RESOURCE_NAME], host_sample
                )
                if host_sample.sample_error:
                    print(
                        f"[{timestamp}] {HOST_RESOURCE_NAME}: {host_sample.sample_error}",
                        file=sys.stderr,
                        flush=True,
                    )
                for container_name in normalized_containers:
                    sample = collector(container_name, timestamp)
                    writer.writerow(sample.as_csv_row())
                    update_container_summary(resource_summaries[container_name], sample)
                    if sample.sample_error:
                        print(
                            f"[{timestamp}] {container_name}: {sample.sample_error}",
                            file=sys.stderr,
                            flush=True,
                        )
                handle.flush()

                elapsed = monotonic() - started_monotonic
                if duration_seconds is not None:
                    remaining = duration_seconds - elapsed
                    if remaining <= 0:
                        break
                    sleep(min(interval_seconds, remaining))
                    if monotonic() - started_monotonic >= duration_seconds:
                        break
                else:
                    sleep(interval_seconds)
    except KeyboardInterrupt:
        interrupted = True

    finished_at = now()
    elapsed_seconds = max(0.0, monotonic() - started_monotonic)
    sample_rows = sum(
        int(item["sample_rows"] or 0) for item in resource_summaries.values()
    )
    successful_samples = sum(
        int(item["successful_samples"] or 0) for item in resource_summaries.values()
    )
    error_samples = sum(
        int(item["error_samples"] or 0) for item in resource_summaries.values()
    )
    if interrupted:
        status = "interrupted"
    elif error_samples:
        status = "completed_with_errors"
    else:
        status = "completed"

    summary: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "experiment_id": experiment,
        "status": status,
        "started_at": isoformat_utc(started_at),
        "finished_at": isoformat_utc(finished_at),
        "elapsed_seconds": round(elapsed_seconds, 3),
        "sampler_interval_seconds": interval_seconds,
        "requested_duration_seconds": duration_seconds,
        "sample_rows": sample_rows,
        "successful_samples": successful_samples,
        "error_samples": error_samples,
        "host": resource_summaries[HOST_RESOURCE_NAME],
        "containers": {
            name: resource_summaries[name] for name in normalized_containers
        },
        "context": metadata or {},
    }
    write_json_atomic(run_directory / "summary.json", summary)

    experiment_payload["status"] = status
    experiment_payload["finished_at"] = summary["finished_at"]
    write_json_atomic(run_directory / "experiment.json", experiment_payload)
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record host metadata and periodic Docker container resource samples."
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Parent directory in which <experiment-id>/ is created.",
    )
    parser.add_argument("--experiment-id", required=True, type=experiment_id)
    parser.add_argument(
        "--container",
        dest="containers",
        action="append",
        type=container_identifier,
        required=True,
        help="Docker container name to sample; repeat for multiple containers.",
    )
    parser.add_argument("--interval", type=positive_float, default=5.0)
    parser.add_argument(
        "--duration",
        type=positive_float,
        help="Optional run duration in seconds; omit to run until Ctrl-C.",
    )
    parser.add_argument(
        "--metadata-file",
        type=Path,
        help="Optional JSON object with input URI/bytes, Git SHA, Job/Run IDs, and Spark settings.",
    )
    return parser


def load_metadata_file(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read metadata JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError("metadata JSON must contain an object")
    return payload


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        metadata = load_metadata_file(args.metadata_file)
        summary = run_sampler(
            args.output_dir,
            args.experiment_id,
            args.containers,
            args.interval,
            args.duration,
            metadata,
        )
    except (FileExistsError, ValueError) as exc:
        print(
            str(exc),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(summary, sort_keys=True))
    if summary["status"] == "interrupted":
        return 130
    return 1 if summary["status"] == "completed_with_errors" else 0


if __name__ == "__main__":
    raise SystemExit(main())
