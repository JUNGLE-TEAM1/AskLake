from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any

from fastapi import status

from app.core.errors import ApiError


BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_DIR / "scripts"


def run_node_bridge(
    script_name: str,
    success_marker: str,
    payload: dict[str, Any],
    *,
    error_marker: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    script_path = SCRIPTS_DIR / script_name
    try:
        result = subprocess.run(
            ["node", str(script_path)],
            cwd=str(BACKEND_DIR),
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ApiError(
            "CONTINUOUS_SQL_WORKER_TIMEOUT",
            f"{script_name} exceeded its {timeout_seconds}s bridge timeout.",
            status.HTTP_504_GATEWAY_TIMEOUT,
            {"timeoutSeconds": timeout_seconds},
        ) from exc
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if result.returncode != 0:
        error_payload = marker_payload(stdout, error_marker) or {}
        raise ApiError(
            error_payload.get("code") or "CONTINUOUS_SQL_WORKER_FAILED",
            error_payload.get("message") or (stderr.strip() or f"{script_name} failed."),
            int(error_payload.get("status") or status.HTTP_502_BAD_GATEWAY),
            {"bridge": error_payload, "stderr": stderr[-4000:], "stdout": stdout[-4000:]},
        )
    response = marker_payload(stdout, success_marker)
    if response is None:
        raise ApiError(
            "CONTINUOUS_SQL_WORKER_BAD_RESPONSE",
            f"{script_name} did not return {success_marker}.",
            status.HTTP_502_BAD_GATEWAY,
            {"stderr": stderr[-4000:], "stdout": stdout[-4000:]},
        )
    response.setdefault("stdout", stdout)
    response.setdefault("stderr", stderr)
    return response


def marker_payload(output: str, marker: str) -> dict[str, Any] | None:
    prefix = f"{marker}="
    for line in reversed(str(output or "").splitlines()):
        if not line.startswith(prefix):
            continue
        try:
            value = json.loads(line[len(prefix):])
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None
    return None
