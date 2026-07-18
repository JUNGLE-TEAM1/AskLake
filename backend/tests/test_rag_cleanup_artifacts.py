import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace


def load_cleanup_module():
    path = Path(__file__).parents[1] / "scripts" / "cleanup-rag-artifacts.py"
    spec = importlib.util.spec_from_file_location("cleanup_rag_artifacts_contract_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResult:
    def __init__(self, manifests):
        self.manifests = manifests

    def all(self):
        return self.manifests


class FakeSession:
    def __init__(self, manifests):
        self.manifests = manifests
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def scalars(self, _statement):
        return FakeResult(self.manifests)

    def commit(self):
        self.committed = True


def test_cleanup_never_deletes_an_index_still_attached_to_its_alias(monkeypatch):
    module = load_cleanup_module()
    manifest = SimpleNamespace(
        activated_at=datetime.now(timezone.utc) - timedelta(days=90),
        alias_name="asklake-rag-reviews",
        checkpoint_path="s3://warehouse/rag/reviews/checkpoint",
        chunk_table=None,
        dataset_id="reviews",
        index_name="asklake-rag-reviews-v1",
        parent_table=None,
        retired_at=datetime.now(timezone.utc) - timedelta(days=60),
        status="retired",
    )
    session = FakeSession([manifest])
    deleted = []

    class FakeOpenSearchClient:
        def alias_indices(self, alias):
            assert alias == manifest.alias_name
            return [manifest.index_name]

        def delete_index(self, index):
            deleted.append(index)

    monkeypatch.setattr(module, "SessionLocal", lambda: session)
    monkeypatch.setattr(module, "OpenSearchClient", lambda _settings: FakeOpenSearchClient())
    monkeypatch.setattr(module.settings, "opensearch_base_url", "http://opensearch:9200")
    monkeypatch.setattr(module.settings, "trino_enabled", False)

    report = module.cleanup_once(apply=True, retention_days=30, keep_previous=0)

    assert report["pendingIndexes"] == [{
        "datasetId": "reviews",
        "index": manifest.index_name,
        "parentTable": None,
        "chunkTable": None,
        "checkpointPath": manifest.checkpoint_path,
    }]
    assert deleted == []
    assert manifest.status == "retired"
    assert session.committed is True


def test_cleanup_keeps_index_pending_when_opensearch_is_unconfigured(monkeypatch):
    module = load_cleanup_module()
    manifest = SimpleNamespace(
        activated_at=datetime.now(timezone.utc) - timedelta(days=90),
        alias_name="asklake-rag-reviews",
        checkpoint_path=None,
        chunk_table=None,
        dataset_id="reviews",
        index_name="asklake-rag-reviews-v1",
        parent_table=None,
        retired_at=datetime.now(timezone.utc) - timedelta(days=60),
        status="retired",
    )
    session = FakeSession([manifest])
    monkeypatch.setattr(module, "SessionLocal", lambda: session)
    monkeypatch.setattr(module.settings, "opensearch_base_url", None)
    monkeypatch.setattr(module.settings, "trino_enabled", False)

    report = module.cleanup_once(apply=True, retention_days=30, keep_previous=0)

    assert [item["index"] for item in report["pendingIndexes"]] == [manifest.index_name]
    assert report["deletedIndexes"] == []
    assert manifest.status == "retired"
