#!/usr/bin/env python3
"""Regression checks for reboot-safe Spark runtime path initialization."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

import ensure_spark_runtime_paths as runtime_paths


original_environment = dict(os.environ)
temporary_root = Path(tempfile.mkdtemp(prefix="asklake-spark-runtime-paths-"))

try:
    os.environ["ASKLAKE_SPARK_RUNTIME_ROOT"] = str(temporary_root)
    os.environ["ASKLAKE_SPARK_RUNTIME_UID"] = str(os.geteuid())
    os.environ["ASKLAKE_SPARK_RUNTIME_GID"] = str(os.getegid())
    os.environ["ASKLAKE_SPARK_RUNTIME_DIRECTORY_MODE"] = "2770"
    os.environ["ASKLAKE_SPARK_RUNTIME_FILE_MODE"] = "0660"

    first_result = runtime_paths.prepare_runtime_paths()
    assert first_result["code"] == "runtime_storage_ready"
    assert (temporary_root / "spark-ivy/cache").is_dir()
    assert (temporary_root / "spark-ivy/jars").is_dir()
    assert (temporary_root / "spark-runs/checkpoints").is_dir()
    assert stat.S_IMODE((temporary_root / "spark-runs").stat().st_mode) == 0o2770

    report_path = temporary_root / "spark-runs/existing-report.json"
    checkpoint_path = temporary_root / "spark-runs/checkpoints/existing-checkpoint"
    report_path.write_text('{"rows": 17}\n', encoding="utf-8")
    checkpoint_path.write_text("offset=42\n", encoding="utf-8")
    report_before = report_path.read_bytes()
    checkpoint_before = checkpoint_path.read_bytes()

    # Simulate path drift followed by a daemon/guard restart. Existing data must
    # survive while the expected owner/mode and missing Ivy directory recover.
    os.chmod(temporary_root / "spark-runs", 0o700)
    shutil.rmtree(temporary_root / "spark-ivy/cache")
    if os.geteuid() == 0:
        os.chown(temporary_root / "spark-output", 1, 1)
    second_result = runtime_paths.prepare_runtime_paths()
    assert second_result["code"] == "runtime_storage_ready"
    assert report_path.read_bytes() == report_before
    assert checkpoint_path.read_bytes() == checkpoint_before
    assert (temporary_root / "spark-ivy/cache").is_dir()
    assert (temporary_root / "spark-output").stat().st_uid == os.geteuid()
    assert stat.S_IMODE((temporary_root / "spark-runs").stat().st_mode) == 0o2770

    # A worker-only restart performs the write/read/rename/delete probe without
    # running the privileged preparation path again.
    writer_result = runtime_paths.writer_probe()
    assert writer_result["probe"] == "writer"
    assert not list(temporary_root.rglob(".asklake-write-*"))

    backend_result = runtime_paths.backend_read_probe()
    assert backend_result["probe"] == "backend_read"
    assert backend_result["ready"] is True

    # Metadata drift must provide exact structured evidence instead of a
    # generic Spark failure.
    os.chmod(temporary_root / "spark-output", 0o700)
    try:
        runtime_paths.check_metadata()
        raise AssertionError("Invalid runtime metadata must fail validation.")
    except runtime_paths.RuntimePathError as error:
        payload = error.payload()
        assert payload["code"] == "runtime_storage_metadata_invalid"
        assert payload["path"] == str(temporary_root / "spark-output")
        assert payload["expected"]["mode"] == "2770"
        assert payload["actual"]["mode"] == "0700"

    runtime_paths.prepare_runtime_paths()
    assert report_path.read_bytes() == report_before
    assert checkpoint_path.read_bytes() == checkpoint_before

    print(json.dumps({
        "code": "spark_runtime_paths_verified",
        "scenarios": [
            "clean_host_directory",
            "daemon_restart_repair",
            "worker_only_restart",
            "wrong_owner_or_mode_repair",
            "existing_data_preserved",
            "backend_read_probe",
            "structured_failure_evidence",
        ],
    }, sort_keys=True))
finally:
    os.environ.clear()
    os.environ.update(original_environment)
    shutil.rmtree(temporary_root, ignore_errors=True)
