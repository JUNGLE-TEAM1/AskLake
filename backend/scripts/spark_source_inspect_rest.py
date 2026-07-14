import io
import json
import os
import sys
from pathlib import Path

import spark_source_inspect


MARKER = "ASKLAKE_SOURCE_INSPECT="


def main():
    report_path = Path(required_env("ASKLAKE_SOURCE_INSPECT_REPORT_FILE"))
    captured = io.StringIO()
    original_stdout = sys.stdout
    sys.stdout = Tee(original_stdout, captured)
    try:
        exit_code = int(spark_source_inspect.main() or 0)
    except Exception as exc:  # The wrapped script validates required runtime inputs.
        print(f"Spark source inspect failed: {exc}", file=sys.stderr)
        return 1
    finally:
        sys.stdout = original_stdout

    if exit_code != 0:
        return exit_code
    marker_line = next(
        (line for line in reversed(captured.getvalue().splitlines()) if line.startswith(MARKER)),
        None,
    )
    if marker_line is None:
        print("Spark source inspect did not produce its result marker.", file=sys.stderr)
        return 1

    try:
        payload = json.loads(marker_line[len(MARKER):])
        report_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = report_path.with_name(f".{report_path.name}.{os.getpid()}.tmp")
        temporary_path.write_text(
            f"{json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)}\n",
            encoding="utf-8",
        )
        temporary_path.replace(report_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Spark source inspect report could not be written: {exc}", file=sys.stderr)
        return 1
    return 0


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name} is required")
    return value


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, value):
        for stream in self.streams:
            stream.write(value)
        return len(value)

    def flush(self):
        for stream in self.streams:
            stream.flush()


if __name__ == "__main__":
    raise SystemExit(main())
