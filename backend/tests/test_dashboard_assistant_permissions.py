import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.schemas.permissions import ResourcePermissions
from app.services.dashboard_assistant_context import _available_dataset_contexts


def dataset_payload(dataset_id: str, owner: str) -> dict[str, object]:
    return {
        "description": f"{dataset_id} description",
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": "2026-07-12T00:00:00Z",
        "layer": "GOLD",
        "name": dataset_id,
        "nextRefresh": "-",
        "owner": owner,
        "quality": "validated",
        "rag": False,
        "rows": "1 row",
        "sampleRows": [["secret"]],
        "schema": [["value", "string"]],
        "size": "1 B",
        "source": "test",
        "status": "available",
        "tags": [],
    }


class DashboardAssistantPermissionTests(unittest.TestCase):
    def test_context_excludes_datasets_without_query_permission(self) -> None:
        repository = SimpleNamespace(
            db=object(),
            list_dataset_models=lambda: [object(), object()],
        )
        payloads = [
            dataset_payload("allowed", "analyst"),
            dataset_payload("forbidden", "another-owner"),
        ]

        def permissions(_db, _actor, *, owner, **_kwargs):
            return ResourcePermissions(can_view=True, can_query=owner == "analyst")

        with (
            patch(
                "app.services.dashboard_assistant_context.dataset_model_to_payload",
                side_effect=payloads,
            ),
            patch(
                "app.services.dashboard_assistant_context.datasets_with_persisted_permission_grants",
                side_effect=lambda _db, datasets: datasets,
            ),
            patch(
                "app.services.dashboard_assistant_context.permissions_for_actor_with_governance",
                side_effect=permissions,
            ),
        ):
            contexts = _available_dataset_contexts(
                repository,
                ActorContext(name="analyst", role="viewer"),
                max_sample_rows=5,
            )

        self.assertEqual([context.id for context in contexts], ["allowed"])
        self.assertEqual(contexts[0].sample_rows, [{"value": "secret"}])


if __name__ == "__main__":
    unittest.main()
