import unittest
from copy import deepcopy
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.catalog import CatalogDatasetModel, CatalogDatasetPreferenceModel
from app.repositories.catalog_repository import CatalogRepository
from app.services.catalog_service import CatalogService, catalog_preference_actor_key


def dataset_payload(dataset_id: str = "dataset-1") -> dict[str, object]:
    return {
        "description": "preference regression fixture",
        "downstream": [],
        "freshness": "latest",
        "id": dataset_id,
        "layer": "SILVER",
        "lastUpdated": "2026-07-14T00:00:00Z",
        "name": dataset_id,
        "nextRefresh": "-",
        "owner": "catalog-owner",
        "quality": "verified",
        "rag": False,
        "rows": "1 row",
        "sampleRows": [["1"]],
        "schema": [["id", "integer"]],
        "size": "1B",
        "source": "fixture",
        "status": "available",
        "tags": [],
        "upstream": [],
    }


class FakeCatalogPreferenceRepository:
    def __init__(self) -> None:
        self.db = object()
        self.payloads = {"dataset-1": dataset_payload()}
        self.preferences: dict[tuple[str, str], CatalogDatasetPreferenceModel] = {}

    def list_dataset_models(self) -> list[CatalogDatasetModel]:
        return [
            CatalogDatasetModel(id=dataset_id, payload=deepcopy(payload))
            for dataset_id, payload in self.payloads.items()
        ]

    def get_dataset_payload(self, dataset_id: str) -> dict[str, object] | None:
        payload = self.payloads.get(dataset_id)
        return deepcopy(payload) if payload is not None else None

    def list_dataset_preferences(
        self,
        actor_key: str,
        dataset_ids: list[str],
    ) -> dict[str, CatalogDatasetPreferenceModel]:
        return {
            dataset_id: preference
            for dataset_id in dataset_ids
            if (preference := self.preferences.get((actor_key, dataset_id))) is not None
        }

    def get_dataset_preference(
        self,
        actor_key: str,
        dataset_id: str,
    ) -> CatalogDatasetPreferenceModel | None:
        return self.preferences.get((actor_key, dataset_id))

    def pin_dataset(
        self,
        actor_key: str,
        dataset_id: str,
    ) -> CatalogDatasetPreferenceModel:
        current = self.preferences.get((actor_key, dataset_id))
        if current is not None and current.pinned:
            return current
        preference = CatalogDatasetPreferenceModel(
            actor_key=actor_key,
            dataset_id=dataset_id,
            pinned=True,
            pinned_at=datetime.now(timezone.utc),
        )
        self.preferences[(actor_key, dataset_id)] = preference
        return preference

    def unpin_dataset(self, actor_key: str, dataset_id: str) -> None:
        self.preferences.pop((actor_key, dataset_id), None)


class CatalogDatasetPreferenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repository = FakeCatalogPreferenceRepository()
        self.service = CatalogService(None, self.repository, None)  # type: ignore[arg-type]
        self.actor_a = ActorContext(id="user-a", name="Same Display Name", role="admin")
        self.actor_b = ActorContext(id="user-b", name="Same Display Name", role="admin")

    def service_dependencies(self):
        return (
            patch(
                "app.services.catalog_service.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch(
                "app.services.catalog_service.datasets_with_persisted_permission_grants",
                side_effect=lambda _db, datasets: datasets,
            ),
            patch(
                "app.services.catalog_service.with_dataset_permissions",
                side_effect=lambda dataset, _actor, _db: dataset,
            ),
            patch("app.services.catalog_service.require_governed_access"),
            patch("app.services.catalog_service.record_forbidden_dataset_event"),
        )

    def test_pin_is_actor_scoped_and_survives_a_service_reload(self) -> None:
        dependencies = self.service_dependencies()
        with dependencies[0], dependencies[1], dependencies[2], dependencies[3], dependencies[4]:
            pinned = self.service.pin_dataset("dataset-1", self.actor_a)
            reloaded_service = CatalogService(None, self.repository, None)  # type: ignore[arg-type]
            actor_a_dataset = reloaded_service.get_dataset("dataset-1", self.actor_a)
            actor_b_dataset = reloaded_service.get_dataset("dataset-1", self.actor_b)

        self.assertTrue(pinned.user_preference.pinned)
        self.assertIsNotNone(pinned.user_preference.pinned_at)
        self.assertTrue(actor_a_dataset.user_preference.pinned)
        self.assertFalse(actor_b_dataset.user_preference.pinned)
        self.assertNotEqual(
            catalog_preference_actor_key(self.actor_a),
            catalog_preference_actor_key(self.actor_b),
        )

    def test_local_actor_name_fallback_is_case_insensitive(self) -> None:
        self.assertEqual(
            catalog_preference_actor_key(ActorContext(name=" Demo User ")),
            catalog_preference_actor_key(ActorContext(name="demo user")),
        )

    def test_list_hydrates_only_the_current_actors_preference(self) -> None:
        self.repository.pin_dataset(catalog_preference_actor_key(self.actor_a), "dataset-1")
        dependencies = self.service_dependencies()
        with dependencies[0], dependencies[1], dependencies[2], dependencies[3], dependencies[4]:
            actor_a_list = self.service.list_datasets(self.actor_a)
            actor_b_list = self.service.list_datasets(self.actor_b)

        self.assertTrue(actor_a_list.datasets[0].user_preference.pinned)
        self.assertFalse(actor_b_list.datasets[0].user_preference.pinned)

    def test_unpin_is_idempotent_and_returns_the_canonical_false_state(self) -> None:
        dependencies = self.service_dependencies()
        with dependencies[0], dependencies[1], dependencies[2], dependencies[3], dependencies[4]:
            self.service.pin_dataset("dataset-1", self.actor_a)
            first = self.service.unpin_dataset("dataset-1", self.actor_a)
            second = self.service.unpin_dataset("dataset-1", self.actor_a)
            reloaded = self.service.get_dataset("dataset-1", self.actor_a)

        self.assertFalse(first.user_preference.pinned)
        self.assertIsNone(first.user_preference.pinned_at)
        self.assertFalse(second.user_preference.pinned)
        self.assertFalse(reloaded.user_preference.pinned)

    def test_repeated_pin_keeps_the_original_pin_timestamp(self) -> None:
        dependencies = self.service_dependencies()
        with dependencies[0], dependencies[1], dependencies[2], dependencies[3], dependencies[4]:
            first = self.service.pin_dataset("dataset-1", self.actor_a)
            second = self.service.pin_dataset("dataset-1", self.actor_a)

        self.assertEqual(
            first.user_preference.pinned_at,
            second.user_preference.pinned_at,
        )

    def test_missing_or_unauthorized_dataset_never_creates_a_preference(self) -> None:
        dependencies = self.service_dependencies()
        with dependencies[0], dependencies[1], dependencies[2], dependencies[3], dependencies[4]:
            with self.assertRaises(ApiError) as missing:
                self.service.pin_dataset("deleted-dataset", self.actor_a)

            with self.assertRaises(ApiError) as forbidden:
                self.service.pin_dataset(
                    "dataset-1",
                    ActorContext(id="viewer", name="not-the-owner", role="viewer"),
                )

        self.assertEqual(missing.exception.status_code, 404)
        self.assertEqual(forbidden.exception.status_code, 403)
        self.assertEqual(self.repository.preferences, {})


class CatalogDatasetPreferenceRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        with self.engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys = ON"))
            connection.execute(text("CREATE TABLE catalog_datasets (id TEXT PRIMARY KEY)"))
            connection.execute(text("INSERT INTO catalog_datasets (id) VALUES ('dataset-1')"))
        self.db = sessionmaker(bind=self.engine)()
        self.repository = CatalogRepository(self.db)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_repository_pin_is_idempotent_and_preserves_the_first_timestamp(self) -> None:
        first = self.repository.pin_dataset("user:user-a", "dataset-1")
        first_pinned_at = first.pinned_at

        second = self.repository.pin_dataset("user:user-a", "dataset-1")

        self.assertTrue(second.pinned)
        self.assertEqual(second.pinned_at, first_pinned_at)
        self.assertEqual(
            len(self.repository.list_dataset_preferences("user:user-a", ["dataset-1"])),
            1,
        )

    def test_repository_unpin_is_idempotent(self) -> None:
        self.repository.pin_dataset("user:user-a", "dataset-1")

        self.repository.unpin_dataset("user:user-a", "dataset-1")
        self.repository.unpin_dataset("user:user-a", "dataset-1")

        self.assertIsNone(
            self.repository.get_dataset_preference("user:user-a", "dataset-1"),
        )

    def test_deleting_a_dataset_cascades_its_preference_rows(self) -> None:
        self.repository.pin_dataset("user:user-a", "dataset-1")

        self.db.execute(text("DELETE FROM catalog_datasets WHERE id = 'dataset-1'"))
        self.db.commit()

        self.assertIsNone(
            self.repository.get_dataset_preference("user:user-a", "dataset-1"),
        )

    def test_concurrent_first_pin_reuses_the_winning_preference(self) -> None:
        concurrent = CatalogDatasetPreferenceModel(
            actor_key="user:user-a",
            dataset_id="dataset-1",
            pinned=True,
            pinned_at=datetime.now(timezone.utc),
        )
        db = Mock()
        db.get.side_effect = [None, concurrent]
        db.flush.side_effect = IntegrityError("INSERT", {}, Exception("duplicate key"))
        repository = CatalogRepository(db)

        with patch("app.repositories.catalog_repository.ensure_catalog_schema"):
            result = repository.pin_dataset("user:user-a", "dataset-1")

        self.assertIs(result, concurrent)
        db.rollback.assert_called_once_with()
        db.commit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
