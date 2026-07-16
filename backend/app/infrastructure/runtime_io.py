"""Production adapters for ETL runtime process, file, and object I/O."""

from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
import subprocess
from typing import Any
from uuid import uuid4

from fastapi import status

from app.core.errors import ApiError
from app.ports.runtime_io import (
    JsonDocument,
    JsonDocumentState,
    ObjectEntry,
)


class SubprocessNodeBridge:
    """Execute a Node bridge and normalize timeout/process/response failures."""

    def __init__(
        self,
        *,
        backend_dir: Path,
        scripts_dir: Path,
        runner: Callable[..., Any] = subprocess.run,
    ) -> None:
        self._backend_dir = backend_dir
        self._scripts_dir = scripts_dir
        self._runner = runner

    def execute(
        self,
        script_name: str,
        success_marker: str,
        payload: dict[str, Any],
        *,
        error_marker: str,
        timeout_seconds: int,
        timeout_recovery: Callable[[], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        script_path = self._scripts_dir / script_name
        try:
            result = self._runner(
                ["node", str(script_path)],
                cwd=str(self._backend_dir),
                input=json.dumps(payload, ensure_ascii=False),
                text=True,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            recovery: dict[str, Any] = {"attempted": timeout_recovery is not None}
            if timeout_recovery is not None:
                try:
                    recovery.update({"result": timeout_recovery(), "succeeded": True})
                except Exception as recovery_error:
                    recovery.update({"error": str(recovery_error), "succeeded": False})
            raise ApiError(
                "BACKEND_BRIDGE_TIMEOUT",
                f"{script_name} exceeded its derived {timeout_seconds}s bridge timeout.",
                status.HTTP_504_GATEWAY_TIMEOUT,
                {"recovery": recovery, "timeoutSeconds": timeout_seconds},
            ) from exc

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        if result.returncode != 0:
            error_payload = _marker_payload(stdout, error_marker) or {}
            raise ApiError(
                error_payload.get("code") or "BACKEND_BRIDGE_FAILED",
                error_payload.get("message") or (stderr.strip() or f"{script_name} failed."),
                int(error_payload.get("status") or status.HTTP_502_BAD_GATEWAY),
                {"bridge": error_payload, "stderr": stderr[-4000:], "stdout": stdout[-4000:]},
            )

        payload_result = _marker_payload(stdout, success_marker)
        if payload_result is None:
            raise ApiError(
                "BACKEND_BRIDGE_BAD_RESPONSE",
                f"{script_name} did not return {success_marker}.",
                status.HTTP_502_BAD_GATEWAY,
                {"stderr": stderr[-4000:], "stdout": stdout[-4000:]},
            )
        payload_result.setdefault("stdout", stdout)
        payload_result.setdefault("stderr", stderr)
        return payload_result


class JsonFileRuntimeDocumentStore:
    """Read and atomically write runtime-owned JSON documents."""

    def read_json(self, path: Path) -> JsonDocument:
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return JsonDocument(JsonDocumentState.MISSING)
        except OSError as exc:
            return JsonDocument(JsonDocumentState.UNREADABLE, error=str(exc))
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            return JsonDocument(
                JsonDocumentState.INVALID,
                error=str(exc),
                line=exc.lineno,
                column=exc.colno,
            )
        if not isinstance(value, dict):
            return JsonDocument(
                JsonDocumentState.INVALID,
                error="Runtime JSON document must contain an object.",
            )
        return JsonDocument(JsonDocumentState.FOUND, value=value)

    def write_json_atomic(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False),
                encoding="utf-8",
            )
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


class Boto3ObjectManifestAdapter:
    """Expose manifest-oriented operations without leaking boto3 responses."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def ensure_exists(self, bucket: str, key: str) -> None:
        self._client.head_object(Bucket=bucket, Key=key)

    def list_entries(self, bucket: str, prefix: str) -> list[ObjectEntry]:
        entries: list[ObjectEntry] = []
        continuation_token: str | None = None
        while True:
            request: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
            if continuation_token:
                request["ContinuationToken"] = continuation_token
            response = self._client.list_objects_v2(**request)
            entries.extend(
                ObjectEntry(
                    key=str(item.get("Key") or ""),
                    size=_optional_int(item.get("Size")),
                )
                for item in response.get("Contents") or []
                if str(item.get("Key") or "")
            )
            if not response.get("IsTruncated"):
                return entries
            continuation_token = str(response.get("NextContinuationToken") or "").strip() or None
            if continuation_token is None:
                raise RuntimeError("Object listing was truncated without a continuation token.")

    def read_text(self, bucket: str, key: str) -> str:
        body = self._client.get_object(Bucket=bucket, Key=key).get("Body")
        raw = body.read() if body is not None and hasattr(body, "read") else body
        return raw.decode("utf-8") if isinstance(raw, bytes) else str(raw or "")


def _marker_payload(output: str, marker: str) -> dict[str, Any] | None:
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


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
