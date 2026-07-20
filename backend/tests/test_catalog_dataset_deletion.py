import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.application.catalog_dataset_deletion import (
    CatalogDatasetDeletionService,
    CatalogPhysicalPurger,
    add_dependency_blockers,
    build_deletion_impact,
    is_managed_storage_location,
    nested_contains,
    process_claimed_deletion,
)
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.catalog import CatalogDatasetModel
from app.models.catalog_deletion import CatalogDatasetDeletionModel
from app.models.etl import ETLJobModel
from app.repositories.catalog_deletion_repository import CatalogDeletionRepository
from app.repositories.catalog_deletion_repository import ensure_catalog_publication_allowed
from app.repositories.catalog_repository import CatalogRepository
from app.repositories import etl_repository
from app.schemas.catalog import CatalogDatasetDeletionImpact, CatalogDatasetResponse


def dataset_payload(dataset_id: str = "ds_orders") -> dict:
    return {
        "description": "orders",
        "downstream": [],
        "freshness": "latest",
        "id": dataset_id,
        "layer": "SILVER",
        "lastUpdated": "2026-07-18T00:00:00Z",
        "materializationRuns": [],
        "name": "orders",
        "nextRefresh": "-",
        "owner": "owner@example.com",
        "permissionGrants": [],
        "permissions": {"canDelete": True, "canQuery": True, "canView": True},
        "quality": "정상",
        "rag": False,
        "rows": "1",
        "sampleRows": [["1"]],
        "schema": [["id", "Long"]],
        "size": "1 B",
        "source": "fixture",
        "status": "available",
        "tags": [],
        "upstream": [],
    }


def deletion_row(status: str = "validating") -> SimpleNamespace:
    return SimpleNamespace(
        actor_snapshot={"name": "owner@example.com", "role": "editor", "groups": []},
        dataset_id="ds_orders",
        dataset_name="orders",
        dataset_snapshot=dataset_payload(),
        error_code=None,
        error_message=None,
        id="catalog_delete_1",
        impact_snapshot={},
        status=status,
    )


class CatalogDeletionRepositoryTest(unittest.TestCase):
    def test_receipt_is_durable_fence_and_failed_request_is_retried(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        CatalogDatasetDeletionModel.__table__.create(engine)
        with Session(engine) as db:
            repository = CatalogDeletionRepository(db)
            row = repository.create_or_retry(
                actor_snapshot={"name": "owner"},
                dataset_id="ds_orders",
                dataset_name="orders",
                dataset_snapshot=dataset_payload(),
                impact_snapshot={"blockers": []},
            )
            self.assertTrue(repository.has_fence("ds_orders"))
            claimed = repository.claim(row.id)
            self.assertEqual(claimed.status, "validating")
            repository.update_status(claimed, "failed", error_code="PURGE_FAILED", error_message="failed")
            retried = repository.create_or_retry(
                actor_snapshot={"name": "owner"},
                dataset_id="ds_orders",
                dataset_name="orders",
                dataset_snapshot=dataset_payload(),
                impact_snapshot={"blockers": []},
            )
            self.assertEqual(retried.id, row.id)
            self.assertEqual(retried.status, "queued")
            self.assertIsNone(retried.error_code)
            with self.assertRaises(ApiError) as raised:
                ensure_catalog_publication_allowed(db, "ds_orders")
            self.assertEqual(raised.exception.code, "DATASET_DELETION_FENCED")


class CatalogPublicationFenceTest(unittest.TestCase):
    def test_catalog_and_etl_publication_locks_check_the_deletion_fence(self) -> None:
        db = MagicMock()
        with (
            patch("app.repositories.catalog_repository.ensure_catalog_schema"),
            patch("app.repositories.catalog_deletion_repository.ensure_catalog_publication_allowed") as catalog_fence,
        ):
            CatalogRepository(db).get_dataset_model_for_update("ds_orders")
        catalog_fence.assert_called_once_with(db, "ds_orders")

        with (
            patch("app.repositories.etl_repository.ensure_schema"),
            patch("app.repositories.catalog_deletion_repository.ensure_catalog_publication_allowed") as etl_fence,
        ):
            etl_repository.get_dataset_by_id_for_update(db, "ds_orders")
        etl_fence.assert_called_once_with(db, "ds_orders")


class CatalogDeletionWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.row = deletion_row()
        self.db = MagicMock()
        self.db.get.side_effect = lambda model, identity: (
            SimpleNamespace(payload=dataset_payload())
            if model is CatalogDatasetModel
            else self.row
            if model is CatalogDatasetDeletionModel
            else None
        )
        self.impact = CatalogDatasetDeletionImpact(
            artifacts=[],
            blockers=[],
            can_delete=True,
            dataset_id="ds_orders",
            dataset_name="orders",
            retained_resources=[],
        )

    def test_physical_purge_precedes_metadata_cleanup_and_success(self) -> None:
        events: list[str] = []
        self.row.dataset_snapshot = {"name": "stale"}
        repository = MagicMock()
        repository.update_status.side_effect = lambda _row, state, **_kwargs: events.append(state)
        purger = MagicMock(spec=CatalogPhysicalPurger)
        purger.purge.side_effect = lambda _db, claimed: (
            self.assertEqual(claimed.dataset_snapshot["name"], "orders"),
            events.append("physical_purge"),
        )
        with (
            patch("app.application.catalog_dataset_deletion.CatalogDeletionRepository", return_value=repository),
            patch("app.application.catalog_dataset_deletion.build_deletion_impact", return_value=self.impact),
            patch("app.application.catalog_dataset_deletion.delete_dataset_metadata", side_effect=lambda _db, _id: events.append("metadata_delete")),
            patch("app.application.catalog_dataset_deletion.add_audit_event", side_effect=lambda *_args, **_kwargs: events.append("audit")),
        ):
            process_claimed_deletion(self.db, self.row, purger=purger)

        self.assertEqual(events, ["purging", "physical_purge", "metadata_cleanup", "metadata_delete", "audit", "succeeded"])
        self.db.commit.assert_called_once()

    def test_physical_purge_failure_keeps_metadata_and_marks_failed(self) -> None:
        repository = MagicMock()
        purger = MagicMock(spec=CatalogPhysicalPurger)
        purger.purge.side_effect = RuntimeError("S3_PURGE_FAILED")
        with (
            patch("app.application.catalog_dataset_deletion.CatalogDeletionRepository", return_value=repository),
            patch("app.application.catalog_dataset_deletion.build_deletion_impact", return_value=self.impact),
            patch("app.application.catalog_dataset_deletion.delete_dataset_metadata") as delete_metadata,
        ):
            process_claimed_deletion(self.db, self.row, purger=purger)

        delete_metadata.assert_not_called()
        self.db.rollback.assert_called_once()
        self.assertEqual(repository.update_status.call_args_list[-1].args[1], "failed")
        self.assertEqual(repository.update_status.call_args_list[-1].kwargs["error_code"], "S3_PURGE_FAILED")


class CatalogDeletionRequestTest(unittest.TestCase):
    def test_exact_dataset_name_is_required_before_request_creation(self) -> None:
        service = CatalogDatasetDeletionService(MagicMock())
        dataset = CatalogDatasetResponse.model_validate(dataset_payload())
        with (
            patch.object(service, "_authorized_dataset", return_value=(dataset, dataset_payload())),
            patch.object(service.deletion_repository, "latest_for_dataset") as latest_deletion,
        ):
            with self.assertRaises(ApiError) as raised:
                service.request(dataset.id, ActorContext(name=dataset.owner), confirm_name="wrong-name")
        self.assertEqual(raised.exception.code, "CATALOG_DATASET_DELETE_CONFIRMATION_MISMATCH")
        latest_deletion.assert_not_called()

    def test_concurrent_request_is_rechecked_after_dataset_lock(self) -> None:
        service = CatalogDatasetDeletionService(MagicMock())
        payload = dataset_payload()
        dataset = CatalogDatasetResponse.model_validate(payload)
        existing = SimpleNamespace(id="catalog_delete_existing", status="queued")
        with (
            patch.object(service, "_authorized_dataset", return_value=(dataset, payload)),
            patch.object(service.catalog_repository, "get_dataset_payload_for_update", return_value=payload),
            patch.object(service.deletion_repository, "latest_for_dataset", side_effect=[None, existing]),
            patch.object(service.deletion_repository, "create_or_retry") as create_or_retry,
        ):
            with self.assertRaises(ApiError) as raised:
                service.request(dataset.id, ActorContext(name=dataset.owner), confirm_name=dataset.name)
        self.assertEqual(raised.exception.code, "CATALOG_DATASET_DELETION_EXISTS")
        create_or_retry.assert_not_called()


class CatalogDeletionSafetyTest(unittest.TestCase):
    def test_nested_dataset_reference_is_detected(self) -> None:
        self.assertTrue(nested_contains({"relations": [{"datasetId": "ds_orders"}]}, "ds_orders"))
        self.assertFalse(nested_contains({"relations": [{"datasetId": "ds_other"}]}, "ds_orders"))

    def test_only_dataset_scoped_local_path_is_managed(self) -> None:
        dataset = CatalogDatasetResponse.model_validate(dataset_payload())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            managed = root / "sql-derived" / "silver" / dataset.id / "run-1" / "data.jsonl"
            unmanaged = root.parent / "source" / "orders.csv"
            with patch("app.application.catalog_dataset_deletion.LocalLakeStorageService") as storage:
                storage.return_value.storage_root = root
                self.assertTrue(is_managed_storage_location(str(managed), dataset))
                self.assertFalse(is_managed_storage_location(str(unmanaged), dataset))

    def test_local_purger_removes_the_dataset_scope_not_unrelated_paths(self) -> None:
        dataset = CatalogDatasetResponse.model_validate(dataset_payload())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset_dir = root / "sql-derived" / "silver" / dataset.id
            data_path = dataset_dir / "run-1" / "data.jsonl"
            unrelated = root / "sql-derived" / "silver" / "ds_other" / "run-1" / "data.jsonl"
            data_path.parent.mkdir(parents=True)
            unrelated.parent.mkdir(parents=True)
            data_path.write_text("{}\n", encoding="utf-8")
            unrelated.write_text("{}\n", encoding="utf-8")
            with patch("app.application.catalog_dataset_deletion.LocalLakeStorageService") as storage:
                storage.return_value.storage_root = root
                CatalogPhysicalPurger()._purge_storage(str(data_path), dataset)
            self.assertFalse(dataset_dir.exists())
            self.assertTrue(unrelated.exists())

    def test_missing_dataset_directory_never_removes_the_storage_root(self) -> None:
        dataset = CatalogDatasetResponse.model_validate(dataset_payload())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unrelated = root / "keep.txt"
            unrelated.write_text("keep", encoding="utf-8")
            missing_dataset_dir = root / dataset.id
            with patch("app.application.catalog_dataset_deletion.LocalLakeStorageService") as storage:
                storage.return_value.storage_root = root
                CatalogPhysicalPurger()._purge_storage(str(missing_dataset_dir), dataset)
            self.assertTrue(root.exists())
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep")

    def test_downstream_summary_labels_are_not_phantom_dataset_blockers(self) -> None:
        payload = dataset_payload()
        payload["downstream"] = ["SQL 분석", "대시보드"]
        dataset = SimpleNamespace(id=payload["id"], name=payload["name"], payload=payload)
        db = MagicMock()

        def rows(statement):
            entities = {item.get("entity") for item in statement.column_descriptions}
            return iter([dataset]) if CatalogDatasetModel in entities else iter([])

        db.scalars.side_effect = rows
        blockers = []
        add_dependency_blockers(db, payload["id"], payload, blockers)
        self.assertEqual(blockers, [])

    def test_scheduled_producer_is_reported_as_a_delete_blocker(self) -> None:
        dataset = CatalogDatasetResponse.model_validate(dataset_payload())
        job = SimpleNamespace(
            dataset_id=dataset.id,
            execution_mode="snapshot",
            id="job_orders",
            name="orders producer",
            schedule="0 3 * * *",
            source_config=[],
            sql_recipe=None,
            status="scheduled",
        )
        db = MagicMock()

        def rows(statement):
            entities = {item.get("entity") for item in statement.column_descriptions}
            return iter([job]) if ETLJobModel in entities else iter([])

        db.scalars.side_effect = rows
        db.scalar.return_value = None
        impact = build_deletion_impact(db, dataset, dataset_payload())
        self.assertFalse(impact.can_delete)
        self.assertTrue(any(item.resource_id == job.id and "예약" in item.reason for item in impact.blockers))


if __name__ == "__main__":
    unittest.main()
