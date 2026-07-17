"""Production adapters for ETL runtime process, file, and object I/O."""

from __future__ import annotations

from collections.abc import Callable
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any
from uuid import uuid4

from fastapi import status

from app.core.errors import ApiError
from app.core.observability import current_correlation_id
from app.ports.runtime_io import (
    JsonDocument,
    JsonDocumentState,
    ObjectEntry,
)


class CallableKafkaRuntimeGateway:
    """Adapt the existing worker facade to the application gateway contract."""

    def __init__(self, handler: Callable[..., dict[str, Any]]) -> None:
        self._handler = handler

    def command(
        self,
        job: Any,
        runtime: Any,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if options is None:
            return self._handler(job, runtime, action)
        return self._handler(job, runtime, action, options)


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
        bridge_id = current_correlation_id() or _bridge_request_id(payload)
        bridge_environment = {
            **os.environ,
            "ASKLAKE_NODE_BRIDGE_VERSION": "1.0",
            "ASKLAKE_NODE_BRIDGE_CORRELATION_ID": bridge_id,
            "ASKLAKE_NODE_BRIDGE_IDEMPOTENCY_KEY": _payload_fingerprint(payload),
        }
        try:
            result = self._runner(
                ["node", str(script_path)],
                cwd=str(self._backend_dir),
                input=json.dumps(payload, ensure_ascii=False),
                text=True,
                capture_output=True,
                encoding="utf-8",
                env=bridge_environment,
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
            error_payload = marker_payload(stdout, error_marker) or {}
            raise ApiError(
                error_payload.get("code") or "BACKEND_BRIDGE_FAILED",
                _redact_diagnostic(
                    error_payload.get("message") or (stderr.strip() or f"{script_name} failed.")
                ),
                int(error_payload.get("status") or status.HTTP_502_BAD_GATEWAY),
                {
                    "bridge": _redact_payload(error_payload),
                    "correlationId": bridge_id,
                    "stderr": _redact_diagnostic(stderr[-4000:]),
                    "stdout": _redact_diagnostic(stdout[-4000:]),
                },
            )

        payload_result = marker_payload(stdout, success_marker)
        if payload_result is None:
            raise ApiError(
                "BACKEND_BRIDGE_BAD_RESPONSE",
                f"{script_name} did not return {success_marker}.",
                status.HTTP_502_BAD_GATEWAY,
                {
                    "correlationId": bridge_id,
                    "stderr": _redact_diagnostic(stderr[-4000:]),
                    "stdout": _redact_diagnostic(stdout[-4000:]),
                },
            )
        payload_result.setdefault("bridgeCorrelationId", bridge_id)
        payload_result.setdefault("stdout", _redact_diagnostic(stdout))
        payload_result.setdefault("stderr", _redact_diagnostic(stderr))
        return payload_result


class VersionedNodeBridge:
    """Run an allow-listed Node operation over a versioned JSON envelope."""

    protocol_version = "1.0"
    max_stdout_chars = 1_000_000
    max_stderr_chars = 4_000

    def __init__(
        self,
        *,
        backend_dir: Path,
        runner: Callable[..., Any] = subprocess.run,
        script_path: Path | None = None,
    ) -> None:
        self._backend_dir = backend_dir
        self._runner = runner
        self._script_path = script_path or backend_dir / "scripts" / "node-json-bridge.mjs"

    def execute_operation(
        self,
        operation: str,
        payload: dict[str, Any],
        *,
        timeout_seconds: int,
        correlation_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        request_id = correlation_id or current_correlation_id() or _bridge_request_id(payload)
        envelope = {
            "version": self.protocol_version,
            "requestId": request_id,
            "idempotencyKey": idempotency_key or _payload_fingerprint({
                "operation": operation,
                "payload": payload,
            }),
            "operation": operation,
            "payload": payload,
        }
        try:
            result = self._runner(
                ["node", str(self._script_path)],
                cwd=str(self._backend_dir),
                input=json.dumps(envelope, ensure_ascii=False),
                text=True,
                capture_output=True,
                encoding="utf-8",
                env={**os.environ, "ASKLAKE_NODE_BRIDGE_VERSION": self.protocol_version},
                errors="replace",
                timeout=max(1, timeout_seconds),
            )
        except subprocess.TimeoutExpired as exc:
            raise ApiError(
                "NODE_BRIDGE_TIMEOUT",
                f"Node bridge operation timed out: {operation}",
                status.HTTP_504_GATEWAY_TIMEOUT,
                {"correlationId": request_id, "stage": "timeout", "timeoutSeconds": timeout_seconds},
            ) from exc
        except OSError as exc:
            raise ApiError(
                "NODE_BRIDGE_START_FAILED",
                f"Node bridge could not start: {operation}",
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "start"},
            ) from exc

        stdout = str(result.stdout or "")
        stderr = _redact_diagnostic(str(result.stderr or "")[-self.max_stderr_chars:])
        if len(stdout) > self.max_stdout_chars:
            raise ApiError(
                "NODE_BRIDGE_PROTOCOL_ERROR",
                "Node bridge response exceeded the protocol limit.",
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "protocol", "stderr": stderr},
            )
        try:
            response = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ApiError(
                "NODE_BRIDGE_PROTOCOL_ERROR",
                "Node bridge returned malformed JSON.",
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "protocol", "stderr": stderr},
            ) from exc
        if not isinstance(response, dict) or response.get("version") != self.protocol_version:
            raise ApiError(
                "NODE_BRIDGE_PROTOCOL_ERROR",
                "Node bridge returned an unsupported protocol response.",
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "protocol", "stderr": stderr},
            )
        if response.get("requestId") != request_id or not isinstance(response.get("ok"), bool):
            raise ApiError(
                "NODE_BRIDGE_PROTOCOL_ERROR",
                "Node bridge response identity is invalid.",
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "protocol", "stderr": stderr},
            )
        if result.returncode != 0 or response.get("ok") is not True:
            error = response.get("error") if isinstance(response.get("error"), dict) else {}
            raise ApiError(
                str(error.get("code") or "NODE_BRIDGE_PROCESS_FAILED"),
                _redact_diagnostic(str(error.get("message") or "Node bridge operation failed.")),
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "process", "stderr": stderr},
            )
        operation_result = response.get("result")
        if not isinstance(operation_result, dict):
            raise ApiError(
                "NODE_BRIDGE_PROTOCOL_ERROR",
                "Node bridge result must be an object.",
                status.HTTP_502_BAD_GATEWAY,
                {"correlationId": request_id, "stage": "protocol", "stderr": stderr},
            )
        return operation_result


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


_SECRET_FIELD_PATTERN = re.compile(
    r'(?i)(password|secret|token|access[_-]?key|authorization)(\s*[=:]\s*|"\s*:\s*")([^\s",}]+)'
)


def _payload_fingerprint(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _bridge_request_id(payload: dict[str, Any]) -> str:
    for key in ("correlationId", "clientRequestId", "runId", "jobId"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value[:200]
    return f"bridge-{uuid4().hex}"


def _redact_diagnostic(value: str) -> str:
    return _SECRET_FIELD_PATTERN.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value)


def _redact_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if re.search(r"(?i)password|secret|token|access[_-]?key|authorization", key)
            else _redact_payload(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_payload(item) for item in value]
    return value


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


def marker_payload(output: str, marker: str) -> dict[str, Any] | None:
    """Read the last ASCII-newline-delimited JSON object for ``marker``.

    ``str.splitlines`` also treats Unicode separators inside valid JSON strings
    as line boundaries.  Bridge output is an ASCII ``\n`` protocol, so only
    split on that byte-equivalent character and remove a trailing CR from
    CRLF output.
    """

    prefix = f"{marker}="
    for raw_line in reversed(str(output or "").split("\n")):
        line = raw_line.removesuffix("\r")
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
