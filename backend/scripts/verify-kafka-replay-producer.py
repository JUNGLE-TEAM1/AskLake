from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from unittest.mock import patch

from app.schemas.etl import KafkaReplayProducerRequest
from app.services import kafka_replay_producer_service as producer_service


class FakeProcess:
    pid = 4242

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.stdout = iter([
            "Review Kafka replay progress: 100 messages sent (cycle 1)\n",
            "Review Kafka replay cycle 1 complete: 100 messages sent\n",
            "Review Kafka replay finished: 200 messages across 2 cycle(s) to reviews.raw at redpanda:9092\n",
        ])

    def poll(self) -> int | None:
        return self.returncode

    def wait(self) -> int:
        self.returncode = 0
        return 0


def main() -> None:
    manager = producer_service.ReplayProducerManager()
    commands: list[list[str]] = []

    def fake_popen(command: list[str], **_kwargs: object) -> FakeProcess:
        commands.append(command)
        return FakeProcess()

    request = KafkaReplayProducerRequest(
        loop=True,
        max_cycles=2,
        max_messages=200,
        rate=2,
        topic="reviews.producer.verify",
        burst_min_messages=500,
        burst_max_messages=1000,
        burst_interval_seconds=10,
    )
    with patch.object(producer_service.subprocess, "Popen", side_effect=fake_popen):
        manager.start(request)
        for _ in range(20):
            if not manager.status().running:
                break
            time.sleep(0.01)

    command = commands[0]
    assert "--loop" in command
    assert "--no-recreate-topic" in command
    assert command[command.index("--payload-mode") + 1] == "json-envelope"
    assert "--recreate-topic" not in command
    assert command[command.index("--max-cycles") + 1] == "2"
    assert command[command.index("--max-messages") + 1] == "200"
    assert command[command.index("--burst-min-messages") + 1] == "500"
    assert command[command.index("--burst-max-messages") + 1] == "1000"
    assert command[command.index("--burst-interval-seconds") + 1] == "10"
    producer_status = manager.status()
    assert not producer_status.running
    assert producer_status.exit_code == 0
    assert producer_status.sent_messages == 200
    assert producer_status.completed_cycles == 2
    assert producer_service.resolve_input_path(None).is_file()

    with tempfile.TemporaryDirectory() as directory:
        json_input = Path(directory) / "click-events.jsonl"
        json_input.write_text(
            json.dumps(
                {
                    "event_id": "EVT-1",
                    "review": "product_click",
                    "created_at": "2026-07-15T00:00:00Z",
                    "raw": {
                        "event_time": "2026-07-15T00:00:00Z",
                        "event_id": "EVT-1",
                        "event_type": "product_click",
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        dry_run = subprocess.run(
            [
                "node",
                str(producer_service.SCRIPT_PATH),
                "--dry-run",
                "--input",
                str(json_input),
                "--limit",
                "1",
            ],
            cwd=producer_service.BACKEND_DIR,
            capture_output=True,
            check=False,
            text=True,
        )
        assert dry_run.returncode == 0, dry_run.stderr
        assert "input valid: 1 messages" in dry_run.stdout

        raw_input = Path(directory) / "click-events.log"
        raw_input.write_text("2026-07-15T00:00:00Z EVT-1 USR-1 SES-1 click P-1 / mobile direct 1\n", encoding="utf-8")
        raw_manager = producer_service.ReplayProducerManager()
        raw_commands: list[list[str]] = []

        def fake_raw_popen(command: list[str], **_kwargs: object) -> FakeProcess:
            raw_commands.append(command)
            return FakeProcess()

        raw_request = KafkaReplayProducerRequest(
            input_path=raw_input.name,
            loop=False,
            max_messages=1,
            payload_mode="raw_text",
            topic="click-events.raw.verify",
        )
        with patch.dict(os.environ, {"ASKLAKE_REPLAY_INPUT_DIR": directory}), patch.object(
            producer_service.subprocess,
            "Popen",
            side_effect=fake_raw_popen,
        ):
            raw_manager.start(raw_request)
            for _ in range(20):
                if not raw_manager.status().running:
                    break
                time.sleep(0.01)

        raw_command = raw_commands[0]
        assert raw_command[raw_command.index("--payload-mode") + 1] == "raw-text"
        assert Path(raw_command[raw_command.index("--input") + 1]).resolve() == raw_input.resolve()

    try:
        KafkaReplayProducerRequest(input_path="../outside.jsonl")
    except ValueError:
        pass
    else:
        raise AssertionError("inputPath traversal must be rejected")

    try:
        KafkaReplayProducerRequest(loop=False, max_cycles=2)
    except ValueError:
        pass
    else:
        raise AssertionError("maxCycles without loop must be rejected")

    try:
        KafkaReplayProducerRequest(loop=True, burst_min_messages=1000, burst_max_messages=500, burst_interval_seconds=10)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid burst bounds must be rejected")

    print("verify-kafka-replay-producer: ok")


if __name__ == "__main__":
    main()
