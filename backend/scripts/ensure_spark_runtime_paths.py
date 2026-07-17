#!/usr/bin/env python3
"""Prepare and validate the shared Spark runtime bind mounts.

The production Compose stack runs this module in three roles:

* a root runtime guard repairs ownership and modes without deleting data;
* the Spark worker proves UID 185 can write and atomically rename files;
* the backend waits until the report directory is readable before booting.

Failures are emitted as one-line JSON so deployment logs can distinguish a
storage problem from a generic Spark process failure.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from typing import Any, NoReturn, Sequence


DEFAULT_RUNTIME_ROOT = "/var/lib/asklake"
DEFAULT_SPARK_UID = 185
DEFAULT_SPARK_GID = 185
DEFAULT_DIRECTORY_MODE = 0o2770
DEFAULT_FILE_MODE = 0o660
READY_FILE_NAME = ".asklake-runtime-ready.json"

MANAGED_DIRECTORY_NAMES = (
    "spark-ivy",
    "spark-output",
    "spark-runs",
    "samples",
    "review-text-models",
)
REQUIRED_DIRECTORY_NAMES = (
    "spark-ivy",
    "spark-ivy/cache",
    "spark-ivy/jars",
    "spark-output",
    "spark-runs",
    "spark-runs/checkpoints",
    "samples",
    "review-text-models",
)
WRITER_PROBE_DIRECTORY_NAMES = (
    "spark-ivy/cache",
    "spark-ivy/jars",
    "spark-output",
    "spark-runs",
    "spark-runs/checkpoints",
)


class RuntimePathError(RuntimeError):
    """A structured runtime storage validation failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        operation: str,
        path: Path | None = None,
        expected: dict[str, Any] | None = None,
        actual: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.operation = operation
        self.path = path
        self.expected = expected or {}
        self.actual = actual or {}

    def payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "operation": self.operation,
            "path": str(self.path) if self.path is not None else None,
            "expected": self.expected,
            "actual": self.actual,
        }


def integer_environment(name: str, default: int) -> int:
    raw_value = str(os.environ.get(name) or "").strip()
    if not raw_value:
        return default
    try:
        return int(raw_value)
    except ValueError as error:
        raise RuntimePathError(
            "runtime_storage_configuration_invalid",
            f"{name} must be an integer.",
            operation="configuration",
            expected={"type": "integer"},
            actual={"value": raw_value},
        ) from error


def mode_environment(name: str, default: int) -> int:
    raw_value = str(os.environ.get(name) or "").strip()
    if not raw_value:
        return default
    try:
        return int(raw_value, 8)
    except ValueError as error:
        raise RuntimePathError(
            "runtime_storage_configuration_invalid",
            f"{name} must be an octal mode such as 2770.",
            operation="configuration",
            expected={"type": "octal_mode"},
            actual={"value": raw_value},
        ) from error


def runtime_root() -> Path:
    return Path(os.environ.get("ASKLAKE_SPARK_RUNTIME_ROOT") or DEFAULT_RUNTIME_ROOT)


def spark_uid() -> int:
    return integer_environment("ASKLAKE_SPARK_RUNTIME_UID", DEFAULT_SPARK_UID)


def spark_gid() -> int:
    return integer_environment("ASKLAKE_SPARK_RUNTIME_GID", DEFAULT_SPARK_GID)


def directory_mode() -> int:
    return mode_environment("ASKLAKE_SPARK_RUNTIME_DIRECTORY_MODE", DEFAULT_DIRECTORY_MODE)


def file_mode() -> int:
    return mode_environment("ASKLAKE_SPARK_RUNTIME_FILE_MODE", DEFAULT_FILE_MODE)


def ready_file(root: Path | None = None) -> Path:
    resolved_root = root or runtime_root()
    return resolved_root / "spark-runs" / READY_FILE_NAME


def stat_payload(path: Path) -> dict[str, Any]:
    try:
        details = path.lstat()
    except FileNotFoundError:
        return {"exists": False}
    return {
        "exists": True,
        "uid": details.st_uid,
        "gid": details.st_gid,
        "mode": f"{stat.S_IMODE(details.st_mode):04o}",
        "type": (
            "symlink"
            if stat.S_ISLNK(details.st_mode)
            else "directory"
            if stat.S_ISDIR(details.st_mode)
            else "file"
            if stat.S_ISREG(details.st_mode)
            else "other"
        ),
    }


def expected_payload(*, mode: int) -> dict[str, Any]:
    return {
        "uid": spark_uid(),
        "gid": spark_gid(),
        "mode": f"{mode:04o}",
    }


def reject_symlink(path: Path, *, operation: str) -> None:
    if path.is_symlink():
        raise RuntimePathError(
            "runtime_storage_unsafe_path",
            "Managed runtime paths must not be symbolic links.",
            operation=operation,
            path=path,
            expected={"type": "directory_or_regular_file"},
            actual=stat_payload(path),
        )


def repair_entry(path: Path, *, entry_mode: int) -> None:
    reject_symlink(path, operation="prepare")
    try:
        details = path.stat()
        if details.st_uid != spark_uid() or details.st_gid != spark_gid():
            os.chown(path, spark_uid(), spark_gid(), follow_symlinks=False)
            details = path.stat()
        if stat.S_IMODE(details.st_mode) != entry_mode:
            os.chmod(path, entry_mode, follow_symlinks=False)
    except OSError as error:
        raise RuntimePathError(
            "runtime_storage_unwritable",
            "Runtime path ownership or mode could not be repaired.",
            operation="prepare",
            path=path,
            expected=expected_payload(mode=entry_mode),
            actual={**stat_payload(path), "error": str(error)},
        ) from error


def repair_tree(path: Path) -> None:
    reject_symlink(path, operation="prepare")
    repair_entry(path, entry_mode=directory_mode())
    for current_root, directory_names, file_names in os.walk(path, followlinks=False):
        current_path = Path(current_root)
        for name in directory_names:
            child = current_path / name
            reject_symlink(child, operation="prepare")
            repair_entry(child, entry_mode=directory_mode())
        for name in file_names:
            child = current_path / name
            reject_symlink(child, operation="prepare")
            repair_entry(child, entry_mode=file_mode())


def atomic_write_ready_file(root: Path) -> None:
    destination = ready_file(root)
    payload = {
        "ready": True,
        "runtimeRoot": str(root),
        "sparkUid": spark_uid(),
        "sparkGid": spark_gid(),
        "directoryMode": f"{directory_mode():04o}",
        "fileMode": f"{file_mode():04o}",
    }
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            dir=destination.parent,
            prefix=f"{READY_FILE_NAME}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, ensure_ascii=False, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary_path, spark_uid(), spark_gid(), follow_symlinks=False)
        os.chmod(temporary_path, file_mode(), follow_symlinks=False)
        os.replace(temporary_path, destination)
    except OSError as error:
        raise RuntimePathError(
            "runtime_storage_unwritable",
            "The runtime readiness file could not be written atomically.",
            operation="atomic_ready_write",
            path=destination,
            expected=expected_payload(mode=file_mode()),
            actual={**stat_payload(destination), "error": str(error)},
        ) from error
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink(missing_ok=True)


def prepare_runtime_paths() -> dict[str, Any]:
    root = runtime_root()
    if os.geteuid() != 0 and (spark_uid() != os.geteuid() or spark_gid() != os.getegid()):
        raise RuntimePathError(
            "runtime_storage_initializer_privilege_required",
            "Runtime path repair must run as root when the target UID/GID differs.",
            operation="prepare",
            path=root,
            expected={"effectiveUid": 0, **expected_payload(mode=directory_mode())},
            actual={"effectiveUid": os.geteuid(), "effectiveGid": os.getegid()},
        )

    try:
        root.mkdir(parents=True, exist_ok=True)
        reject_symlink(root, operation="prepare")
        for relative_name in REQUIRED_DIRECTORY_NAMES:
            directory = root / relative_name
            directory.mkdir(parents=True, exist_ok=True)
            reject_symlink(directory, operation="prepare")
        for relative_name in MANAGED_DIRECTORY_NAMES:
            repair_tree(root / relative_name)
        atomic_write_ready_file(root)
    except RuntimePathError:
        raise
    except OSError as error:
        raise RuntimePathError(
            "runtime_storage_unwritable",
            "Spark runtime directories could not be created.",
            operation="prepare",
            path=root,
            expected=expected_payload(mode=directory_mode()),
            actual={**stat_payload(root), "error": str(error)},
        ) from error

    return check_metadata()


def check_entry(path: Path, *, entry_mode: int, operation: str) -> None:
    actual = stat_payload(path)
    expected = expected_payload(mode=entry_mode)
    if (
        not actual.get("exists")
        or actual.get("type") not in {"directory", "file"}
        or actual.get("uid") != expected["uid"]
        or actual.get("gid") != expected["gid"]
        or actual.get("mode") != expected["mode"]
    ):
        raise RuntimePathError(
            "runtime_storage_metadata_invalid",
            "Runtime path owner, group, or mode does not match the contract.",
            operation=operation,
            path=path,
            expected=expected,
            actual=actual,
        )


def check_metadata() -> dict[str, Any]:
    root = runtime_root()
    for relative_name in REQUIRED_DIRECTORY_NAMES:
        check_entry(root / relative_name, entry_mode=directory_mode(), operation="check_metadata")
    check_entry(ready_file(root), entry_mode=file_mode(), operation="check_metadata")
    try:
        payload = json.loads(ready_file(root).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimePathError(
            "runtime_storage_unreadable",
            "Runtime readiness evidence is missing or malformed.",
            operation="check_metadata",
            path=ready_file(root),
            expected={"ready": True},
            actual={**stat_payload(ready_file(root)), "error": str(error)},
        ) from error
    if payload.get("ready") is not True:
        raise RuntimePathError(
            "runtime_storage_not_ready",
            "Runtime readiness evidence is not active.",
            operation="check_metadata",
            path=ready_file(root),
            expected={"ready": True},
            actual=payload,
        )
    return {
        "code": "runtime_storage_ready",
        "runtimeRoot": str(root),
        "sparkUid": spark_uid(),
        "sparkGid": spark_gid(),
        "directoryMode": f"{directory_mode():04o}",
        "fileMode": f"{file_mode():04o}",
    }


def writer_probe() -> dict[str, Any]:
    check_metadata()
    root = runtime_root()
    probe_value = b"asklake-runtime-probe\n"
    for relative_name in WRITER_PROBE_DIRECTORY_NAMES:
        directory = root / relative_name
        source: Path | None = None
        destination: Path | None = None
        try:
            descriptor, source_name = tempfile.mkstemp(dir=directory, prefix=".asklake-write-", suffix=".tmp")
            source = Path(source_name)
            with os.fdopen(descriptor, "wb") as output:
                output.write(probe_value)
                output.flush()
                os.fsync(output.fileno())
            destination = source.with_suffix(".ready")
            os.replace(source, destination)
            if destination.read_bytes() != probe_value:
                raise OSError("probe content changed after atomic rename")
        except OSError as error:
            raise RuntimePathError(
                "runtime_storage_unwritable",
                "Spark UID cannot write, read, and atomically rename in a runtime path.",
                operation="writer_probe",
                path=directory,
                expected={
                    **expected_payload(mode=directory_mode()),
                    "effectiveUid": spark_uid(),
                    "capabilities": ["write", "read", "atomic_rename", "delete"],
                },
                actual={
                    **stat_payload(directory),
                    "effectiveUid": os.geteuid(),
                    "effectiveGid": os.getegid(),
                    "error": str(error),
                },
            ) from error
        finally:
            if source is not None:
                source.unlink(missing_ok=True)
            if destination is not None:
                destination.unlink(missing_ok=True)
    return {
        **check_metadata(),
        "probe": "writer",
        "paths": [str(root / name) for name in WRITER_PROBE_DIRECTORY_NAMES],
    }


def backend_read_probe() -> dict[str, Any]:
    metadata = check_metadata()
    evidence_path = ready_file()
    try:
        payload = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimePathError(
            "runtime_storage_unreadable",
            "Backend cannot read Spark runtime readiness evidence.",
            operation="backend_read_probe",
            path=evidence_path,
            expected={"capability": "read", **expected_payload(mode=file_mode())},
            actual={**stat_payload(evidence_path), "error": str(error)},
        ) from error
    return {**metadata, "probe": "backend_read", "ready": payload.get("ready") is True}


def wait_for_probe(probe, *, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error: RuntimePathError | None = None
    while time.monotonic() < deadline:
        try:
            return probe()
        except RuntimePathError as error:
            last_error = error
            time.sleep(1)
    if last_error is not None:
        raise RuntimePathError(
            last_error.code,
            f"Runtime storage was not ready within {timeout_seconds} seconds.",
            operation="startup_wait",
            path=last_error.path,
            expected=last_error.expected,
            actual=last_error.actual,
        )
    raise RuntimePathError(
        "runtime_storage_not_ready",
        f"Runtime storage was not ready within {timeout_seconds} seconds.",
        operation="startup_wait",
        path=runtime_root(),
    )


def exec_after_probe(probe, command: Sequence[str]) -> NoReturn:
    if not command:
        raise RuntimePathError(
            "runtime_storage_configuration_invalid",
            "An executable command is required after --.",
            operation="exec",
        )
    timeout_seconds = integer_environment("ASKLAKE_SPARK_RUNTIME_WAIT_SECONDS", 120)
    wait_for_probe(probe, timeout_seconds=timeout_seconds)
    os.execvp(command[0], list(command))


def exec_after_prepare(command: Sequence[str]) -> NoReturn:
    if not command:
        raise RuntimePathError(
            "runtime_storage_configuration_invalid",
            "An executable command is required after --.",
            operation="exec",
        )
    prepare_runtime_paths()
    os.execvp(command[0], list(command))


def guard() -> NoReturn:
    prepare_runtime_paths()
    interval_seconds = max(1, integer_environment("ASKLAKE_SPARK_RUNTIME_GUARD_INTERVAL_SECONDS", 30))
    while True:
        check_metadata()
        time.sleep(interval_seconds)


def emit_success(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), flush=True)


def fail(error: Exception) -> NoReturn:
    if isinstance(error, RuntimePathError):
        payload = error.payload()
    else:
        payload = {
            "code": "runtime_storage_unknown_error",
            "message": str(error),
            "operation": "unknown",
            "path": str(runtime_root()),
            "expected": {},
            "actual": {},
        }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), file=sys.stderr, flush=True)
    raise SystemExit(1)


def command_after_separator(arguments: Sequence[str]) -> list[str]:
    if arguments and arguments[0] == "--":
        return list(arguments[1:])
    return list(arguments)


def main(arguments: Sequence[str] | None = None) -> int:
    values = list(arguments if arguments is not None else sys.argv[1:])
    if not values:
        raise RuntimePathError(
            "runtime_storage_configuration_invalid",
            "A command is required.",
            operation="configuration",
            actual={"supported": [
                "prepare",
                "guard",
                "check-metadata",
                "check-writer",
                "check-backend",
                "prepare-backend-exec",
                "wait-writer-exec",
                "wait-backend-exec",
            ]},
        )

    command, *remaining = values
    if command == "prepare":
        emit_success(prepare_runtime_paths())
        return 0
    if command == "guard":
        guard()
    if command == "check-metadata":
        emit_success(check_metadata())
        return 0
    if command == "check-writer":
        emit_success(writer_probe())
        return 0
    if command == "check-backend":
        emit_success(backend_read_probe())
        return 0
    if command == "prepare-backend-exec":
        exec_after_prepare(command_after_separator(remaining))
    if command == "wait-writer-exec":
        exec_after_probe(writer_probe, command_after_separator(remaining))
    if command == "wait-backend-exec":
        exec_after_probe(backend_read_probe, command_after_separator(remaining))
    raise RuntimePathError(
        "runtime_storage_configuration_invalid",
        f"Unsupported command: {command}",
        operation="configuration",
        actual={"command": command},
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as unhandled_error:
        fail(unhandled_error)
