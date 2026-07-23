import json
from pathlib import Path
from typing import Any

from app import models as _models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.models.base import Base
from app.repositories.catalog_repository import CatalogRepository
from app.services.pair2_demo_data import build_direct_lineage_graph


FIXTURE_PATH = Path(__file__).with_name("demo_mongo_fixture.json")


def seed_mongo_demo() -> None:
    Base.metadata.create_all(bind=engine)
    fixture = load_fixture()
    with SessionLocal() as session:
        repository = CatalogRepository(session)
        for collection in fixture["collections"]:
            repository.save_dataset_payload(build_catalog_payload(collection))
    print(f"Mongo demo catalog datasets seeded: {len(fixture['collections'])}")


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def build_catalog_payload(collection: dict[str, Any]) -> dict[str, Any]:
    schema = collection["schema"]
    documents = collection["documents"]
    sample_rows = [
        [stringify_cell(value_at_path(document, column_name)) for column_name, _ in schema]
        for document in documents
    ]
    layer = collection.get("layer", "BRONZE")
    dataset_id = collection["datasetId"]
    dataset_name = collection["name"]
    source_name = collection["sourceName"]
    return {
        "description": collection["description"],
        "downstream": ["검색/카탈로그", "SQL 분석", "비정형 데이터 데모"],
        "freshness": "latest",
        "id": dataset_id,
        "layer": layer,
        "lastUpdated": "2026-07-07T00:00:00.000Z",
        "lineageGraph": build_direct_lineage_graph(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            layer=layer,
            schema=schema,
            source_engine="MONGODB",
            source_id=collection["sourceId"],
            source_name=source_name,
        ),
        "name": dataset_name,
        "nextRefresh": "수동 갱신",
        "owner": "Data Platform Team",
        "quality": "Preview verified",
        "rag": True,
        "rows": f"{len(documents)} documents",
        "sampleRows": sample_rows,
        "schema": schema,
        "size": "seed fixture",
        "source": source_name,
        "status": "available",
        "tags": collection["tags"],
        "upstream": collection["upstream"],
    }


def value_at_path(document: dict[str, Any], path: str) -> Any:
    value: Any = document
    for segment in path.split("."):
        if not isinstance(value, dict) or segment not in value:
            return ""
        value = value[segment]
    return value


def stringify_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(stringify_cell(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


if __name__ == "__main__":
    seed_mongo_demo()
