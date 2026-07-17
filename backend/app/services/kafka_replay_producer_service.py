from __future__ import annotations

from collections import deque
from datetime import UTC, datetime
import os
from pathlib import Path
import re
import signal
import subprocess
from threading import Lock, Thread
from typing import Any

from fastapi import status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.etl import KafkaReplayProducerRequest, KafkaReplayProducerStatus


BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPT_PATH = BACKEND_DIR / "scripts" / "seed-kafka-review-fixture.mjs"
DEFAULT_INPUT_PATH = BACKEND_DIR / "fixtures" / "kafka" / "amazon-review-fixture.jsonl"
MAX_LOG_LINES = 200
_PROGRESS_PATTERN = re.compile(r"Review Kafka replay progress: ([\d,]+) messages sent \(cycle (\d+)\)")
_FINISHED_PATTERN = re.compile(r"Review Kafka replay finished: ([\d,]+) messages across (\d+) cycle")


class ReplayProducerManager:
    def __init__(self) -> None:
        self._lock = Lock()
        self._process: subprocess.Popen[str] | None = None
        self._config: dict[str, Any] | None = None
        self._logs: deque[str] = deque(maxlen=MAX_LOG_LINES)
        self._started_at: str | None = None
        self._finished_at: str | None = None
        self._sent_messages = 0
        self._completed_cycles = 0

    def start(self, request: KafkaReplayProducerRequest) -> KafkaReplayProducerStatus:
        with self._lock:
            if self._is_running_locked():
                raise ApiError(ErrorCode.CONFLICT, "Kafka replay producer is already running.", status.HTTP_409_CONFLICT)

            input_path = resolve_input_path(request.input_path, request.payload_mode)
            command = [
                "node", str(SCRIPT_PATH),
                "--broker", os.environ.get("ASKLAKE_KAFKA_BROKER") or "127.0.0.1:19092",
                "--topic", request.topic,
                "--input", str(input_path),
                "--payload-mode", request.payload_mode.replace("_", "-"),
                "--rate", str(request.rate),
                "--batch-size", str(request.batch_size),
                "--progress-every", str(request.progress_every),
                "--no-recreate-topic",
            ]
            if request.loop:
                command.append("--loop")
            if request.max_cycles is not None:
                command.extend(["--max-cycles", str(request.max_cycles)])
            if request.max_messages is not None:
                command.extend(["--max-messages", str(request.max_messages)])
            if request.cycle_delay_ms:
                command.extend(["--cycle-delay-ms", str(request.cycle_delay_ms)])
            if request.burst_min_messages is not None:
                command.extend(["--burst-min-messages", str(request.burst_min_messages)])
                command.extend(["--burst-max-messages", str(request.burst_max_messages)])
                command.extend(["--burst-interval-seconds", str(request.burst_interval_seconds)])

            self._logs.clear()
            self._sent_messages = 0
            self._completed_cycles = 0
            self._started_at = iso_now()
            self._finished_at = None
            self._config = {
                "batchSize": request.batch_size,
                "burstIntervalSeconds": request.burst_interval_seconds,
                "burstMaxMessages": request.burst_max_messages,
                "burstMinMessages": request.burst_min_messages,
                "cycleDelayMs": request.cycle_delay_ms,
                "inputPath": str(input_path),
                "loop": request.loop,
                "maxCycles": request.max_cycles,
                "maxMessages": request.max_messages,
                "payloadMode": request.payload_mode,
                "rate": request.rate,
                "topic": request.topic,
            }
            self._append_log("Kafka replay producer start requested.")
            self._process = subprocess.Popen(
                command,
                cwd=str(BACKEND_DIR),
                env=os.environ.copy(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                start_new_session=True,
            )
            Thread(target=self._read_output, args=(self._process,), daemon=True).start()
            return self._status_locked()

    def stop(self) -> KafkaReplayProducerStatus:
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise ApiError(ErrorCode.INVALID_JOB_STATE, "Kafka replay producer is not running.", status.HTTP_422_UNPROCESSABLE_ENTITY)
            self._append_log("Kafka replay producer stop requested.")
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            return self._status_locked()

    def status(self) -> KafkaReplayProducerStatus:
        with self._lock:
            return self._status_locked()

    def _read_output(self, process: subprocess.Popen[str]) -> None:
        if process.stdout is not None:
            for line in process.stdout:
                self._record_output(line.rstrip())
        process.wait()
        with self._lock:
            self._finished_at = iso_now()
            self._append_log(f"Kafka replay producer exited with code {process.returncode}.")

    def _record_output(self, line: str) -> None:
        if not line:
            return
        with self._lock:
            self._append_log(line)
            progress_match = _PROGRESS_PATTERN.search(line)
            if progress_match:
                self._sent_messages = int(progress_match.group(1).replace(",", ""))
                self._completed_cycles = max(self._completed_cycles, int(progress_match.group(2)))
            finished_match = _FINISHED_PATTERN.search(line)
            if finished_match:
                self._sent_messages = int(finished_match.group(1).replace(",", ""))
                self._completed_cycles = int(finished_match.group(2))

    def _append_log(self, line: str) -> None:
        self._logs.append(line)

    def _is_running_locked(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _status_locked(self) -> KafkaReplayProducerStatus:
        process = self._process
        running = self._is_running_locked()
        return KafkaReplayProducerStatus(
            completed_cycles=self._completed_cycles,
            config=self._config,
            exit_code=None if running or process is None else process.returncode,
            finished_at=self._finished_at,
            logs=list(self._logs),
            pid=process.pid if process is not None else None,
            running=running,
            sent_messages=self._sent_messages,
            started_at=self._started_at,
        )


def resolve_input_path(input_path: str | None, payload_mode: str = "json_envelope") -> Path:
    configured_root = Path(os.environ.get("ASKLAKE_REPLAY_INPUT_DIR") or DEFAULT_INPUT_PATH.parent).resolve()
    if payload_mode == "raw_text" and input_path is None:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "inputPath is required when payloadMode is raw_text.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    candidate = (configured_root / input_path).resolve() if input_path else DEFAULT_INPUT_PATH.resolve()
    if input_path is not None and configured_root not in candidate.parents and candidate != configured_root:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "inputPath must stay inside ASKLAKE_REPLAY_INPUT_DIR.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if not candidate.is_file():
        raise ApiError(ErrorCode.NOT_FOUND, f"Kafka replay input does not exist: {candidate.name}", status.HTTP_404_NOT_FOUND)
    allowed_suffixes = (".txt", ".txt.gz", ".log", ".log.gz", ".jsonl", ".jsonl.gz") if payload_mode == "raw_text" else (".jsonl", ".jsonl.gz")
    if not candidate.name.lower().endswith(allowed_suffixes):
        expected = ".txt/.log/.jsonl" if payload_mode == "raw_text" else ".jsonl"
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Kafka replay input must be {expected} (optionally gzip-compressed) for payloadMode={payload_mode}.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return candidate


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


replay_producer_manager = ReplayProducerManager()
