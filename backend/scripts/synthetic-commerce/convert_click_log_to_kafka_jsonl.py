#!/usr/bin/env python3
"""Convert AskLake's 10-field click log into the deployed Kafka replay contract."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import sys


FIELD_NAMES = (
    "event_time",
    "event_id",
    "user_id",
    "session_id",
    "event_type",
    "product_id",
    "page_url",
    "device_type",
    "referrer",
    "position",
)


def parse_click_log_line(line: str, line_number: int, source: str) -> dict[str, object]:
    values = line.strip().split()
    if len(values) != len(FIELD_NAMES):
        raise ValueError(
            f"line {line_number}: expected {len(FIELD_NAMES)} whitespace-delimited fields, got {len(values)}"
        )

    raw: dict[str, object] = dict(zip(FIELD_NAMES, values))
    try:
        raw["position"] = int(str(raw["position"]))
    except ValueError as error:
        raise ValueError(f"line {line_number}: position must be an integer") from error

    event_time = str(raw["event_time"])
    try:
        datetime.fromisoformat(event_time.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"line {line_number}: event_time must be ISO-8601") from error

    event_id = str(raw["event_id"])
    return {
        "schema_version": "1.0",
        "event_id": event_id,
        "source": source,
        "offset": line_number,
        "review": str(raw["event_type"]),
        "created_at": event_time,
        "raw": raw,
    }


def convert_click_log(
    input_path: Path,
    output_path: Path,
    *,
    source: str = "click-events-log",
    progress_every: int = 100_000,
) -> dict[str, int | str]:
    if not input_path.is_file():
        raise FileNotFoundError(f"click log input does not exist: {input_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
    row_count = 0
    byte_count = 0

    try:
        with input_path.open("r", encoding="utf-8", newline="") as source_file, temporary_path.open(
            "w", encoding="utf-8", newline="\n"
        ) as target_file:
            for line_number, line in enumerate(source_file, start=1):
                if not line.strip():
                    continue
                record = parse_click_log_line(line, line_number, source)
                encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
                target_file.write(encoded)
                row_count += 1
                byte_count += len(encoded.encode("utf-8"))
                if progress_every > 0 and row_count % progress_every == 0:
                    print(f"click-log Kafka conversion progress: {row_count:,} rows", file=sys.stderr)
        if row_count == 0:
            raise ValueError("click log input did not contain any records")
        temporary_path.replace(output_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise

    return {
        "bytes": byte_count,
        "input": str(input_path),
        "output": str(output_path),
        "rows": row_count,
        "source": source,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="10-field click-events.log path")
    parser.add_argument("--output", required=True, type=Path, help="Kafka replay .jsonl output path")
    parser.add_argument("--source", default="click-events-log")
    parser.add_argument("--progress-every", type=int, default=100_000)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = convert_click_log(
        args.input,
        args.output,
        source=args.source,
        progress_every=max(args.progress_every, 0),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
