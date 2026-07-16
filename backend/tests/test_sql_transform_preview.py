from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.catalog import get_catalog_service
from app.core.auth_context import ActorContext, get_actor_context
from app.main import create_app


class FakeCatalogService:
    def __init__(self) -> None:
        self.dataset_id = "ds-amazon"

    def get_dataset(self, dataset_id: str, actor: ActorContext) -> SimpleNamespace:
        assert dataset_id == self.dataset_id
        assert actor.name == "preview.user"
        return SimpleNamespace(
            name="amazon_products",
            schema_=[
                ("title", "string"),
                ("category", "string"),
                ("price", "double"),
                ("average_rating", "double"),
            ],
        )

    def get_dataset_rows(
        self,
        dataset_id: str,
        actor: ActorContext,
        *,
        limit: int,
        offset: int,
    ) -> SimpleNamespace:
        assert dataset_id == self.dataset_id
        assert actor.name == "preview.user"
        assert limit == 100
        assert offset == 0
        return SimpleNamespace(
            columns=["title", "category", "price", "average_rating"],
            row_count=10_000,
            rows=[
                ["Mister Roberts", "Camera", "15.5", "4.8"],
                ["Low rated camera", "Camera", "9.9", "3.2"],
                ["Great filter", "Filters", "64.95", "4.6"],
            ],
        )


def preview_client() -> TestClient:
    app = create_app()
    app.dependency_overrides[get_actor_context] = lambda: ActorContext(name="preview.user", role="admin")
    app.dependency_overrides[get_catalog_service] = lambda: FakeCatalogService()
    return TestClient(app)


def preview_payload(sql: str) -> dict[str, object]:
    return {
        "sources": [{
            "source_dataset_id": "ds-amazon",
            "columns": ["title", "category", "price", "average_rating"],
        }],
        "sql": sql,
        "limit": 10,
    }


def test_sql_transform_preview_executes_against_catalog_rows() -> None:
    response = preview_client().post(
        "/api/sql/test",
        json=preview_payload(
            "SELECT title, category, price, average_rating "
            "FROM input WHERE average_rating >= 4"
        ),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["preview_origin"] == "catalog"
    assert payload["dataset_row_count"] == 10_000
    assert [column["name"] for column in payload["schema"]] == [
        "title",
        "category",
        "price",
        "average_rating",
    ]
    assert [row["title"] for row in payload["sample_rows"]] == ["Mister Roberts", "Great filter"]
    assert all(float(row["average_rating"]) >= 4 for row in payload["sample_rows"])


def test_sql_transform_preview_rejects_external_relation() -> None:
    response = preview_client().post(
        "/api/sql/test",
        json=preview_payload("SELECT title FROM secret_table"),
    )

    assert response.status_code == 400
    assert "selected Catalog input" in response.json()["error"]["message"]


def test_sql_transform_preview_rejects_unknown_column() -> None:
    response = preview_client().post(
        "/api/sql/test",
        json=preview_payload("SELECT password FROM input"),
    )

    assert response.status_code == 400
    assert "unknown columns" in response.json()["error"]["message"]
