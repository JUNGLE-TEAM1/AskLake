#!/usr/bin/env python3
"""Write a secret-free deployment diagnostic record atomically."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


CHECK_PATTERN = re.compile(r"^[a-z][a-z0-9_]*=(passed|failed|skipped)$")


def parse_check(value: str) -> dict[str, str]:
    match = CHECK_PATTERN.fullmatch(value)
    if match is None:
        raise argparse.ArgumentTypeError(
            "check must have the form name=passed|failed|skipped"
        )
    name, status = value.split("=", 1)
    return {"name": name, "status": status}


def safe_app_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise argparse.ArgumentTypeError(
            "app URL must be an http(s) origin without credentials, query, or fragment"
        )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--command", required=True, choices=("diagnose",))
    parser.add_argument("--app-url", type=safe_app_url)
    parser.add_argument("--instance-state")
    parser.add_argument("--check", action="append", default=[], type=parse_check)
    return parser.parse_args()


def write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=True, indent=2)
            stream.write("\n")
        os.replace(temporary_path, path)
    except BaseException:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    arguments = parse_arguments()
    checks = arguments.check
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "command": arguments.command,
        "checks": checks,
        "overallStatus": "failed"
        if any(check["status"] == "failed" for check in checks)
        else "passed",
    }
    if arguments.app_url:
        payload["appUrl"] = arguments.app_url
    if arguments.instance_state:
        payload["instanceState"] = arguments.instance_state

    write_json_atomic(arguments.output, payload)
    print(arguments.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
