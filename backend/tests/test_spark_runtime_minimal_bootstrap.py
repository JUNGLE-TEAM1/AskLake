import importlib.util
from pathlib import Path
from unittest.mock import patch

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ensure_spark_runtime_paths.py"


def load_runtime_paths_module():
    spec = importlib.util.spec_from_file_location("asklake_runtime_paths_for_test", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_minimal_backend_prepares_shared_paths_before_exec() -> None:
    runtime_paths = load_runtime_paths_module()

    with (
        patch.object(runtime_paths, "prepare_runtime_paths") as prepare,
        patch.object(runtime_paths.os, "execvp", side_effect=RuntimeError("exec-called")) as execvp,
    ):
        with pytest.raises(RuntimeError, match="exec-called"):
            runtime_paths.main(["prepare-backend-exec", "--", "uvicorn", "app.main:app"])

    prepare.assert_called_once_with()
    execvp.assert_called_once_with("uvicorn", ["uvicorn", "app.main:app"])
