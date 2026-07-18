import importlib.util
import json
import sys
import types
from pathlib import Path


def load_rag_chunk_staging(monkeypatch):
    pyspark = types.ModuleType("pyspark")
    pyspark_sql = types.ModuleType("pyspark.sql")
    pyspark_types = types.ModuleType("pyspark.sql.types")
    pyspark_sql.types = pyspark_types
    pyspark.sql = pyspark_sql

    spark_job_run = types.ModuleType("spark_job_run")
    spark_job_run.make_spark = lambda *_args, **_kwargs: None
    spark_job_run.required_env = lambda name: name
    spark_job_run.quote_spark_identifier = lambda value: value

    monkeypatch.setitem(sys.modules, "pyspark", pyspark)
    monkeypatch.setitem(sys.modules, "pyspark.sql", pyspark_sql)
    monkeypatch.setitem(sys.modules, "pyspark.sql.types", pyspark_types)
    monkeypatch.setitem(sys.modules, "spark_job_run", spark_job_run)

    scripts_dir = Path(__file__).parents[1] / "scripts"
    monkeypatch.syspath_prepend(str(scripts_dir))
    path = scripts_dir / "rag_chunk_staging.py"
    spec = importlib.util.spec_from_file_location("rag_chunk_staging_transport_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_post_chunks_uses_http_transport_and_returns_chunks(monkeypatch):
    module = load_rag_chunk_staging(monkeypatch)
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"chunks": [{"text": "real chunk"}]}).encode("utf-8")

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["authorization"] = request.headers.get("Authorization")
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)

    chunks = module.post_chunks(
        "http://embedding-worker:8091/internal/rag/chunk",
        "worker-token",
        [{"document_id": "doc-1", "body": "whole document"}],
        {"jobId": "job-1", "targetTokens": 800, "overlapTokens": 200},
    )

    assert chunks == [{"text": "real chunk"}]
    assert captured["url"].endswith("/internal/rag/chunk")
    assert captured["authorization"] == "Bearer worker-token"
    assert captured["payload"]["parents"][0]["body"] == "whole document"
    assert captured["payload"]["idempotency_key"].startswith("rag-chunk:job-1:")
    assert captured["timeout"] == 300
