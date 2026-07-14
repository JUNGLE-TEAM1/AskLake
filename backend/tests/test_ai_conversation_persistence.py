import unittest

from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.models.ai import AiConversationMessageModel, AiConversationModel
from app.main import create_app
from app.repositories.ai_conversation_repository import AiConversationRepository
from app.schemas.ai import (
    CreateAiConversationMessageRequest,
    CreateAiConversationRequest,
    UpdateAiConversationRequest,
)
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryAiSuggestionResponse
from app.services.ai_conversation_service import AiConversationService


def dataset(dataset_id: str = "dataset-1") -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "AI conversation fixture",
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": "2026-07-14T00:00:00Z",
        "layer": "GOLD",
        "name": "orders_daily",
        "nextRefresh": "manual",
        "owner": "analyst",
        "quality": "passed",
        "rag": False,
        "rows": "10",
        "sampleRows": [["2026-07-14", "10"]],
        "schema": [["order_date", "date"], ["orders", "integer"]],
        "size": "1 KB",
        "source": "orders",
        "status": "available",
        "tags": ["orders"],
    })


class FakeQueryAiService:
    def __init__(self) -> None:
        self.datasets = {"dataset-1": dataset()}
        self.suggestion_calls = 0

    def resolve_context_datasets(
        self,
        dataset_ids,
        _actor,
        *,
        api_path,
        http_method="POST",
    ):
        del api_path, http_method
        resolved = []
        for dataset_id in dataset_ids:
            if dataset_id not in self.datasets:
                raise ApiError(
                    ErrorCode.NOT_FOUND,
                    "Dataset not found",
                    status.HTTP_404_NOT_FOUND,
                    {"datasetId": dataset_id},
                )
            resolved.append(self.datasets[dataset_id])
        return resolved

    def create_suggestion(
        self,
        request,
        _actor,
        *,
        api_path,
        resolved_datasets,
    ):
        del api_path, resolved_datasets
        self.suggestion_calls += 1
        return QueryAiSuggestionResponse(
            body=f"{request.prompt} 요청으로 SQL 초안을 만들었습니다.",
            model="test-model",
            notices=[],
            sql="SELECT order_date, orders FROM orders_daily LIMIT 100;",
            title="주문 SQL",
        )


class AiConversationPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        AiConversationModel.__table__.create(bind=self.engine)
        AiConversationMessageModel.__table__.create(bind=self.engine)
        self.db = Session(self.engine)
        self.query_ai = FakeQueryAiService()
        self.service = AiConversationService(
            AiConversationRepository(self.db),
            self.query_ai,
        )
        self.actor = ActorContext(
            id="user-1",
            name="analyst",
            role="viewer",
        )

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_conversations_are_scoped_to_the_authenticated_owner(self) -> None:
        created = self.service.create_conversation(CreateAiConversationRequest(), self.actor)

        own_list = self.service.list_conversations(self.actor)
        other_list = self.service.list_conversations(
            ActorContext(id="user-2", name="analyst", role="admin"),
        )

        self.assertEqual([item.id for item in own_list.items], [created.id])
        self.assertEqual(other_list.items, [])
        with self.assertRaises(ApiError) as hidden:
            self.service.get_conversation(
                created.id,
                ActorContext(id="user-2", name="analyst", role="admin"),
            )
        self.assertEqual(hidden.exception.status_code, status.HTTP_404_NOT_FOUND)

    def test_dataset_selection_is_validated_and_versioned(self) -> None:
        created = self.service.create_conversation(CreateAiConversationRequest(), self.actor)
        updated = self.service.update_conversation(
            created.id,
            UpdateAiConversationRequest(
                version=created.version,
                selected_dataset_ids=["dataset-1", "dataset-1"],
            ),
            self.actor,
        )

        self.assertEqual(updated.selected_dataset_ids, ["dataset-1"])
        self.assertEqual(updated.version, 2)
        with self.assertRaises(ApiError) as stale:
            self.service.update_conversation(
                created.id,
                UpdateAiConversationRequest(version=1, title="stale title"),
                self.actor,
            )
        self.assertEqual(stale.exception.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(stale.exception.details["currentVersion"], 2)

        with self.assertRaises(ApiError) as deleted_dataset:
            self.service.update_conversation(
                created.id,
                UpdateAiConversationRequest(
                    version=2,
                    selected_dataset_ids=["deleted-dataset"],
                ),
                self.actor,
            )
        self.assertEqual(deleted_dataset.exception.status_code, status.HTTP_404_NOT_FOUND)

    def test_lock_refreshes_a_stale_identity_before_version_check(self) -> None:
        created = self.service.create_conversation(CreateAiConversationRequest(), self.actor)
        with Session(self.engine) as concurrent_db:
            concurrent_model = concurrent_db.get(AiConversationModel, created.id)
            concurrent_model.version = 2
            concurrent_model.title = "다른 요청의 제목"
            concurrent_db.commit()

        with self.assertRaises(ApiError) as stale:
            self.service.update_conversation(
                created.id,
                UpdateAiConversationRequest(version=1, title="덮어쓰면 안 됨"),
                self.actor,
            )

        self.assertEqual(stale.exception.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(stale.exception.details["currentVersion"], 2)

    def test_message_request_persists_user_and_assistant_atomically_and_is_idempotent(self) -> None:
        created = self.service.create_conversation(
            CreateAiConversationRequest(selected_dataset_ids=["dataset-1"]),
            self.actor,
        )
        request = CreateAiConversationMessageRequest(
            version=created.version,
            client_request_id="request-1",
            content="일별 주문을 보여줘",
        )

        response = self.service.create_message(created.id, request, self.actor)
        replay = self.service.create_message(created.id, request, self.actor)

        self.assertEqual(response.version, 2)
        self.assertEqual(response.title, "일별 주문을 보여줘")
        self.assertEqual([message.role for message in response.messages], ["user", "assistant"])
        self.assertEqual(response.messages[1].sql, "SELECT order_date, orders FROM orders_daily LIMIT 100;")
        self.assertEqual(len(replay.messages), 2)
        self.assertEqual(self.query_ai.suggestion_calls, 1)

        with self.assertRaises(ApiError) as stale:
            self.service.create_message(
                created.id,
                CreateAiConversationMessageRequest(
                    version=1,
                    client_request_id="request-2",
                    content="다른 질문",
                ),
                self.actor,
            )
        self.assertEqual(stale.exception.status_code, status.HTTP_409_CONFLICT)

    def test_delete_uses_the_same_optimistic_version(self) -> None:
        created = self.service.create_conversation(CreateAiConversationRequest(), self.actor)
        updated = self.service.update_conversation(
            created.id,
            UpdateAiConversationRequest(version=1, title="보존할 대화"),
            self.actor,
        )

        with self.assertRaises(ApiError) as stale:
            self.service.delete_conversation(created.id, 1, self.actor)
        self.assertEqual(stale.exception.status_code, status.HTTP_409_CONFLICT)

        self.service.delete_conversation(created.id, updated.version, self.actor)
        self.assertEqual(self.service.list_conversations(self.actor).items, [])


class AiConversationRouteContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        AiConversationModel.__table__.create(bind=self.engine)
        AiConversationMessageModel.__table__.create(bind=self.engine)
        self.db = Session(self.engine)
        self.actor = {"value": ActorContext(id="route-user", name="route-user", role="viewer")}
        self.app = create_app()
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_actor_context] = lambda: self.actor["value"]
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.client.close()
        self.app.dependency_overrides.clear()
        self.db.close()
        self.engine.dispose()

    def test_http_contract_exposes_camel_case_versions_and_owner_hidden_404(self) -> None:
        created_response = self.client.post("/api/ai/conversations", json={})
        self.assertEqual(created_response.status_code, status.HTTP_201_CREATED)
        created = created_response.json()
        self.assertEqual(created["title"], "새 대화")
        self.assertEqual(created["selectedDatasetIds"], [])
        self.assertEqual(created["version"], 1)

        updated_response = self.client.patch(
            f"/api/ai/conversations/{created['id']}",
            json={"title": "저장된 제목", "version": 1},
        )
        self.assertEqual(updated_response.status_code, status.HTTP_200_OK)
        self.assertEqual(updated_response.json()["version"], 2)

        stale_delete = self.client.delete(
            f"/api/ai/conversations/{created['id']}?version=1",
        )
        self.assertEqual(stale_delete.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(stale_delete.json()["error"]["code"], "CONFLICT")

        self.actor["value"] = ActorContext(id="another-user", name="route-user", role="admin")
        hidden = self.client.get(f"/api/ai/conversations/{created['id']}")
        self.assertEqual(hidden.status_code, status.HTTP_404_NOT_FOUND)

        self.actor["value"] = ActorContext(id="route-user", name="route-user", role="viewer")
        deleted = self.client.delete(f"/api/ai/conversations/{created['id']}?version=2")
        self.assertEqual(deleted.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(deleted.content, b"")


if __name__ == "__main__":
    unittest.main()
