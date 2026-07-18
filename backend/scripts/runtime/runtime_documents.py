"""Runtime JSON document I/O shared by local and object-store Spark workers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from runtime.contracts import atomic_write_json


def runtime_document_with_suffix(path: str, suffix: str) -> str:
    parent, separator, filename = path.rpartition("/")
    stem, extension_separator, _extension = filename.rpartition(".")
    updated = f"{stem if extension_separator else filename}{suffix}"
    return f"{parent}{separator}{updated}" if separator else updated


def catalog_ack_batch_id(report_path: str, spark: Any) -> int:
    ack_path = runtime_document_with_suffix(report_path, ".catalog-ack.json")
    try:
        payload = json.loads(read_runtime_document(ack_path, spark))
        return int(payload.get("batchId"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return -1


def requested_runtime_action(path_value: str, spark: Any, worker_attempt_id: str | None) -> str:
    try:
        raw = read_runtime_document(path_value, spark).strip()
        if not raw:
            return ""
        command = json.loads(raw)
        command_attempt_id = str(command.get("workerAttemptId") or "")
        if command_attempt_id and command_attempt_id != str(worker_attempt_id or ""):
            return ""
        return str(command.get("action") or "")
    except (OSError, json.JSONDecodeError):
        return ""


def read_runtime_document(path_value: str, spark: Any) -> str:
    if not _is_object_store(path_value):
        try:
            with open(path_value, encoding="utf-8") as source:
                return source.read()
        except OSError:
            return ""
    try:
        path, filesystem = _filesystem(path_value, spark)
        if not filesystem.exists(path):
            return ""
        source = filesystem.open(path)
        try:
            return bytes(source.readAllBytes()).decode("utf-8")
        finally:
            source.close()
    except Exception:  # Runtime report reads must not stop the streaming query.
        return ""


def write_runtime_document_json(
    path_value: str,
    payload: dict[str, Any],
    spark: Any,
    *,
    schema_version: int,
) -> None:
    if not _is_object_store(path_value):
        atomic_write_json(
            Path(path_value),
            payload,
            schema_field="runtimeReportSchemaVersion",
            schema_version=schema_version,
        )
        return
    path, filesystem = _filesystem(path_value, spark)
    _mkdir_parent(path, filesystem)
    output = filesystem.create(path, True)
    try:
        document = {"runtimeReportSchemaVersion": schema_version, **payload}
        output.write(bytearray(json.dumps(document, ensure_ascii=False).encode("utf-8")))
    finally:
        output.close()


def runtime_document_exists(path_value: str, spark: Any) -> bool:
    if not _is_object_store(path_value):
        return os.path.exists(path_value)
    try:
        path, filesystem = _filesystem(path_value, spark)
        return bool(filesystem.exists(path))
    except Exception:
        return False


def write_runtime_marker(path_value: str, value: str, spark: Any) -> None:
    if not _is_object_store(path_value):
        with open(path_value, "w", encoding="utf-8") as target:
            target.write(value)
        return
    path, filesystem = _filesystem(path_value, spark)
    _mkdir_parent(path, filesystem)
    output = filesystem.create(path, True)
    try:
        output.write(bytearray(value.encode("utf-8")))
    finally:
        output.close()


def _is_object_store(path: str) -> bool:
    return path.lower().startswith(("s3://", "s3a://"))


def _filesystem(path_value: str, spark: Any):
    if spark is None:
        raise RuntimeError("Spark must be initialized before accessing an object-store runtime document.")
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    path = jvm.org.apache.hadoop.fs.Path(path_value)
    return path, path.getFileSystem(hadoop)


def _mkdir_parent(path: Any, filesystem: Any) -> None:
    parent = path.getParent()
    if parent is not None:
        filesystem.mkdirs(parent)
