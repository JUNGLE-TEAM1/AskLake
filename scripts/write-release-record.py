#!/usr/bin/env python3
"""Write a deterministic deploy-readiness record for CI artifacts."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile


VALID_STATUSES = {"passed", "failed", "skipped"}


def current_revision() -> str:
    configured_revision = os.environ.get("GITHUB_SHA")
    if configured_revision:
        return configured_revision
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True
    ).strip()


def parse_check(value: str) -> dict[str, str]:
    name, separator, status = value.partition("=")
    if not separator or not name or status not in VALID_STATUSES:
        raise argparse.ArgumentTypeError(
            "check must use <name>=passed|failed|skipped"
        )
    return {"name": name, "status": status}


def write_json_atomically(output_path: Path, payload: dict[str, object]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=output_path.parent, delete=False
    ) as temporary_file:
        json.dump(payload, temporary_file, ensure_ascii=False, indent=2)
        temporary_file.write("\n")
        temporary_path = Path(temporary_file.name)
    temporary_path.replace(output_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source", default="local")
    parser.add_argument("--revision", default=None)
    parser.add_argument("--check", action="append", default=[], type=parse_check)
    arguments = parser.parse_args()

    if not arguments.check:
        parser.error("at least one --check is required")

    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "revision": arguments.revision or current_revision(),
        "source": arguments.source,
        "checks": arguments.check,
        "overallStatus": (
            "failed"
            if any(check["status"] == "failed" for check in arguments.check)
            else "passed"
        ),
    }
    write_json_atomically(arguments.output, payload)
    print(arguments.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
