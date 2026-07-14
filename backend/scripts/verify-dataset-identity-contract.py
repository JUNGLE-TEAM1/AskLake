from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.models.base import Base
from app.repositories import etl_repository
from app.schemas.etl import CreatePipelineRequest
from app.services import etl_service


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs) -> str:
    return "JSON"


def main() -> None:
    assert etl_service.make_dataset_id("customer_orders") == "ds_customer_orders"
    assert etl_service.make_dataset_id("상품이에요") != etl_service.make_dataset_id("클릭 이에요")
    assert etl_service.make_dataset_id("a-b") != etl_service.make_dataset_id("a b")
    assert etl_service.make_dataset_id("a-b") != etl_service.make_dataset_id("a_b")
    assert etl_service.dataset_storage_key("상품이에요") != etl_service.dataset_storage_key("클릭 이에요")

    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    etl_repository._schema_ready_bind_ids.add(id(engine))
    actor = ActorContext(name="admin", role="admin")

    with Session(engine) as db:
        products = etl_service.create_pipeline(db, pipeline_request("상품이에요", "products"), actor)
        clicks = etl_service.create_pipeline(db, pipeline_request("클릭 이에요", "clicks"), actor)

        assert products.job.id != clicks.job.id
        assert products.catalog_target is not None
        assert clicks.catalog_target is not None
        assert products.catalog_target["id"] != clicks.catalog_target["id"]
        assert len(etl_repository.list_job_models(db)) == 2

        products_again = etl_service.create_pipeline(
            db,
            pipeline_request("상품이에요", "products-updated"),
            actor,
        )
        assert products_again.job.id == products.job.id
        assert products_again.catalog_target is not None
        assert products_again.catalog_target["id"] == products.catalog_target["id"]
        assert products_again.job.source_label == "products-updated"
        assert len(etl_repository.list_job_models(db)) == 2

        stored_clicks = etl_repository.get_job(db, clicks.job.id)
        assert stored_clicks is not None
        assert stored_clicks.target == "클릭 이에요"
        assert stored_clicks.source_label == "clicks"

    print("verify-dataset-identity-contract: ok")


def pipeline_request(target_dataset: str, source_label: str) -> CreatePipelineRequest:
    return CreatePipelineRequest.model_validate({
        "id": f"dataset-identity-{source_label}",
        "jobName": f"{target_dataset}_pipeline",
        "owner": "data-team-01",
        "permissionSummary": "Data Platform Team",
        "ruleContractVersion": "1.0",
        "rules": [],
        "ruleSummary": "pass-through",
        "scheduleLabel": "스케줄링 건너뛰기",
        "schemaColumns": [{
            "included": True,
            "nullable": False,
            "sourceName": "event_id",
            "targetName": "event_id",
            "type": "String",
        }],
        "schemaSampleRows": [["EVT-1"]],
        "schemaSummary": "1개 컬럼",
        "sourceConfig": [["Table", source_label]],
        "sourceLabel": source_label,
        "sourceType": "PostgreSQL",
        "targetDataset": target_dataset,
        "targetFormat": "parquet",
        "targetLayer": "GOLD",
    })


if __name__ == "__main__":
    main()
