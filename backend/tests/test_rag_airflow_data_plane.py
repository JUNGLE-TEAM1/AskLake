import importlib.util
import sys
import types
from pathlib import Path

import pytest


def load_rag_dag_module(monkeypatch):
    airflow = types.ModuleType("airflow")
    sdk = types.ModuleType("airflow.sdk")
    exceptions = types.ModuleType("airflow.exceptions")
    pendulum = types.ModuleType("pendulum")

    class AirflowFailException(Exception):
        pass

    class AirflowSkipException(Exception):
        pass

    def fake_dag(**_kwargs):
        def decorate(function):
            def do_not_build_dag(*_args, **_inner_kwargs):
                return None

            do_not_build_dag.__wrapped__ = function
            return do_not_build_dag

        return decorate

    sdk.dag = fake_dag
    sdk.task = lambda **_kwargs: lambda function: function
    exceptions.AirflowFailException = AirflowFailException
    exceptions.AirflowSkipException = AirflowSkipException
    pendulum.datetime = lambda *args, **kwargs: (args, kwargs)

    class Now:
        @staticmethod
        def to_iso8601_string():
            return "2026-07-17T00:00:00Z"

    pendulum.now = lambda *_args, **_kwargs: Now()
    monkeypatch.setitem(sys.modules, "airflow", airflow)
    monkeypatch.setitem(sys.modules, "airflow.sdk", sdk)
    monkeypatch.setitem(sys.modules, "airflow.exceptions", exceptions)
    monkeypatch.setitem(sys.modules, "pendulum", pendulum)

    path = Path(__file__).parents[2] / "airflow" / "dags" / "asklake_rag_index.py"
    spec = importlib.util.spec_from_file_location("asklake_rag_index_contract_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_stage_start_retries_callback_but_never_hides_superseded_job(monkeypatch):
    module = load_rag_dag_module(monkeypatch)
    original_post_callback_json = module.post_callback_json
    attempts = {"count": 0}

    def transient_then_success(*_args, **_kwargs):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise RuntimeError("RAG internal API request failed: temporary")
        return {"status": "staging", "stage": "staging"}

    monkeypatch.setattr(module, "post_json", transient_then_success)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)
    assert module.post_callback_json("http://backend/result", {"status": "parent_staged"}, "token")["stage"] == "staging"
    assert attempts["count"] == 3

    monkeypatch.setenv("ASKLAKE_EXECUTION_API_BASE_URL", "http://backend")
    monkeypatch.setenv("ASKLAKE_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        module,
        "post_callback_json",
        lambda *_args, **_kwargs: {
            "status": "failed",
            "stage": "failed",
            "error": "superseded activation generation",
        },
    )
    with pytest.raises(module.RagStageRejectedError, match="superseded"):
        module.require_stage_start(
            {"jobId": "job-1", "datasetId": "dataset-1"},
            status="chunked",
            stage="chunking",
        )

    structured_error = module.RagHttpError(
        409,
        "conflict",
        {
            "error": {
                "code": "rag_job_superseded",
                "message": "superseded immutable build",
                "details": {"stopDag": True, "retryable": False},
            }
        },
    )
    monkeypatch.setattr(module, "post_callback_json", original_post_callback_json)
    monkeypatch.setattr(module, "post_json", lambda *_args, **_kwargs: (_ for _ in ()).throw(structured_error))
    with pytest.raises(module.RagStageRejectedError, match="superseded immutable"):
        module.post_callback_json("http://backend/result", {"status": "chunked"}, "token")


def test_ready_retry_is_skippable_and_physical_tasks_have_bounded_retries(monkeypatch):
    module = load_rag_dag_module(monkeypatch)
    with pytest.raises(module.RagJobAlreadyComplete):
        module.ensure_stage_callback_allows_work({"status": "ready", "stage": "ready"})
    with pytest.raises(module.RagJobAlreadyComplete, match="advanced"):
        module.ensure_stage_callback_allows_work(
            {"status": "indexing", "stage": "indexing"},
            expected_stage="embedding",
        )
    assert module.RAG_PHYSICAL_TASK_RETRY_ARGS["retries"] == 2
    assert module.RAG_PHYSICAL_TASK_RETRY_ARGS["retry_exponential_backoff"] is True

    source = (Path(__file__).parents[2] / "airflow" / "dags" / "asklake_rag_index.py").read_text(encoding="utf-8")
    assert 'guard_stage_start(conf, status="parent_staged", stage="staging")' in source
    assert 'guard_stage_start(conf, status="chunked", stage="chunking")' in source
    assert 'guard_stage_start(conf, status="embedding", stage="embedding")' in source
    assert 'status="validating"' in source
