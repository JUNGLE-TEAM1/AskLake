from typing import Any

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.models.etl import ETLJobModel
from app.schemas.catalog import CatalogDatasetResponse, CreateDerivedDatasetRequest
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoClientPage, TrinoQueryRunError
from app.services.query_engine_registration_service import physical_table_name
from app.services.etl_service import dataset_payload_from_spark_result
from app.services.trino_materialization_service import TrinoMaterializationService, materialized_dataset_id


class FakeDb:
    def rollback(self) -> None:
        pass


class FakeSqlRepository:
    def __init__(self, source_payload: dict[str, Any]) -> None:
        self.db = FakeDb()
        self.payloads = {str(source_payload["runId"]): source_payload}

    def get_run_payload(self, run_id: str) -> dict[str, Any] | None:
        payload = self.payloads.get(run_id)
        return dict(payload) if payload else None

    def save_run_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads[str(payload["runId"])] = dict(payload)
        return payload


class FakeCatalogRepository:
    def __init__(self) -> None:
        self.db = FakeDb()
        self.payloads: dict[str, dict[str, Any]] = {}

    def get_dataset_payload(self, dataset_id: str) -> dict[str, Any] | None:
        payload = self.payloads.get(dataset_id)
        return dict(payload) if payload else None

    def get_dataset_payload_by_name(self, dataset_name: str) -> dict[str, Any] | None:
        return next((dict(payload) for payload in self.payloads.values() if payload.get("name") == dataset_name), None)

    def save_dataset_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads[str(payload["id"])] = dict(payload)
        return payload


class FakeTrinoClient:
    def __init__(self) -> None:
        self.describe_succeeds = True
        self.submit_succeeds = True
        self.queries: list[str] = []

    def submit(self, query: str) -> TrinoClientPage:
        self.queries.append(query)
        if not query.startswith("DESCRIBE ") and not self.submit_succeeds:
            raise RuntimeError("TRINO_COORDINATOR_UNAVAILABLE")
        if query.startswith("DESCRIBE ") and not self.describe_succeeds:
            return TrinoClientPage(
                queryId="describe_failed",
                error=TrinoQueryRunError(code="TABLE_NOT_FOUND", message="Table not found"),
                rawStats={"state": "FAILED"},
                state="FAILED",
            )
        if query.startswith("DESCRIBE "):
            return TrinoClientPage(
                queryId="describe_succeeded",
                rawStats={"state": "FINISHED"},
                rows=[["order_id", "varchar", "", ""]],
                state="FINISHED",
            )
        return TrinoClientPage(
            queryId=f"query_{len(self.queries)}",
            rawStats={"state": "FINISHED"},
            state="FINISHED",
        )

    def fetch(self, next_uri: str) -> TrinoClientPage:
        raise AssertionError(f"Unexpected continuation: {next_uri}")


def source_run_payload() -> dict[str, Any]:
    return {
        "baseDatasetId": "ds_orders",
        "compiledQuery": 'SELECT order_id FROM "iceberg"."asklake"."orders"',
        "completedAt": "2026-07-11T00:00:00Z",
        "engine": "trino",
        "query": "SELECT order_id FROM orders",
        "referenceDatasetIds": [],
        "result": {
            "columns": ["order_id"],
            "rowCount": 3,
            "storageStatus": "available",
        },
        "runId": "trino_source_verify",
        "status": "succeeded",
        "submittedAt": "2026-07-11T00:00:00Z",
        "submittedByName": "Demo User",
        "submittedByUserId": "user_demo",
    }


def materialization_request(dataset_name: str) -> CreateDerivedDatasetRequest:
    return CreateDerivedDatasetRequest.model_validate({
        "dataset": {
            "description": "Registration verification",
            "layer": "GOLD",
            "name": dataset_name,
            "rag": False,
            "refreshPolicy": "manual",
            "tags": ["#verify"],
        },
        "query": "SELECT order_id FROM orders",
        "referenceDatasetIds": [],
        "sourceDatasetId": "ds_orders",
        "sourceRunId": "trino_source_verify",
    })


def build_service(client: FakeTrinoClient) -> tuple[TrinoMaterializationService, FakeSqlRepository, FakeCatalogRepository]:
    sql_repository = FakeSqlRepository(source_run_payload())
    catalog_repository = FakeCatalogRepository()
    service = TrinoMaterializationService(
        sql_repository,  # type: ignore[arg-type]
        catalog_repository,  # type: ignore[arg-type]
        Settings(_env_file=None, trino_enabled=True),
        client=client,  # type: ignore[arg-type]
    )
    return service, sql_repository, catalog_repository


def verify() -> None:
    actor = ActorContext(name="Demo User", role="viewer", id="user_demo")
    client = FakeTrinoClient()
    service, _, catalog_repository = build_service(client)
    response = service.submit("trino_source_verify", materialization_request("한국어 주문 분석"), actor)
    dataset = catalog_repository.payloads[response.dataset_id]

    assert response.status == "succeeded"
    assert response.query_engine_status == "available"
    assert dataset["queryEngineStatus"] == "available"
    assert dataset["queryEngineTable"]["table"].startswith("dataset_")
    assert any(query.startswith("CREATE TABLE ") for query in client.queries)
    assert any(query.startswith("DESCRIBE ") for query in client.queries)
    assert dataset["permissionGrants"][0]["principalType"] == "user"
    assert set(dataset["permissionGrants"][0]["actions"]) == {"view", "query", "run", "manage", "delete", "share"}

    malformed_pending = CatalogDatasetResponse.model_validate({
        **dataset,
        "queryEngineStatus": "pending",
        "queryEngineTable": dataset["queryEngineTable"],
    })
    assert malformed_pending.query_engine_table is None

    try:
        service.submit("trino_source_verify", materialization_request("한국어 주문 분석"), actor)
    except ApiError as error:
        assert error.code == ErrorCode.CONFLICT
    else:
        raise AssertionError("Duplicate Dataset names must be rejected before a second CTAS")

    failing_client = FakeTrinoClient()
    failing_client.describe_succeeds = False
    failing_service, failing_sql_repository, failing_catalog_repository = build_service(failing_client)
    failed = failing_service.submit("trino_source_verify", materialization_request("검증 실패 데이터셋"), actor)
    failed_dataset = failing_catalog_repository.payloads[failed.dataset_id]
    assert failed.status == "succeeded"
    assert failed.query_engine_status == "registration_failed"
    assert failed_dataset["queryEngineStatus"] == "registration_failed"
    assert failed_dataset["queryEngineError"] == "TABLE_NOT_FOUND"
    assert "queryEngineTable" not in failed_dataset

    failing_client.describe_succeeds = True
    recovered = failing_service.refresh(failed.materialization_id, actor)
    recovered_dataset = failing_catalog_repository.payloads[recovered.dataset_id]
    assert recovered.query_engine_status == "available"
    assert recovered_dataset["queryEngineStatus"] == "available"
    assert "queryEngineError" not in recovered_dataset
    assert failing_sql_repository.payloads[recovered.materialization_id]["queryEngineStatus"] == "available"

    unavailable_client = FakeTrinoClient()
    unavailable_client.submit_succeeds = False
    unavailable_service, _, unavailable_catalog_repository = build_service(unavailable_client)
    unavailable_request = materialization_request("제출 재시도 데이터셋")
    try:
        unavailable_service.submit("trino_source_verify", unavailable_request, actor)
    except RuntimeError as error:
        assert str(error) == "TRINO_COORDINATOR_UNAVAILABLE"
    else:
        raise AssertionError("Coordinator submission failure must be returned")
    failed_dataset_id = materialized_dataset_id("제출 재시도 데이터셋")
    assert unavailable_catalog_repository.payloads[failed_dataset_id]["queryEngineStatus"] == "registration_failed"
    unavailable_client.submit_succeeds = True
    retried = unavailable_service.submit("trino_source_verify", unavailable_request, actor)
    assert retried.query_engine_status == "available"

    assert materialized_dataset_id("한국어 데이터셋") != materialized_dataset_id("다른 데이터셋")
    assert materialized_dataset_id("한글 데이터셋") == materialized_dataset_id("한글  데이터셋")
    assert physical_table_name("같은 이름", "materialize_a") != physical_table_name("같은 이름", "materialize_b")

    etl_job = ETLJobModel(
        id="JOB-QUERY-ENGINE-VERIFY",
        name="Parquet output verify",
        owner="Data Team",
        status="scheduled",
        tag="[검증]",
        source="S3 fixture",
        target="parquet_output_verify",
        schedule="수동",
        source_config=[],
        source_label="S3 fixture",
        source_type="File / S3 Parquet",
        schema_columns=[],
        schema_sample_rows=[],
        target_format="parquet",
        target_layer="SILVER",
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="-",
        last_state="준비됨",
        next_run="-",
        stats={},
        dag_steps=[],
    )
    plain_parquet = dataset_payload_from_spark_result(
        etl_job,
        {"outputPath": "/tmp/asklake-query-engine-verify", "outputRows": 3, "runId": "etl_run_plain", "status": "success"},
        "ds_parquet_output_verify",
        [["order_id", "string"]],
        "2026-07-11T00:00:00Z",
    )
    assert plain_parquet["queryEngineStatus"] == "unavailable"
    assert "queryEngineTable" not in plain_parquet
    assert "SQL 분석" not in plain_parquet["downstream"]

    verified_table = {"catalog": "iceberg", "schema": "asklake", "table": "orders_verified", "format": "iceberg"}
    verified_parquet = dataset_payload_from_spark_result(
        etl_job,
        {
            "outputPath": "/tmp/asklake-query-engine-verify",
            "outputRows": 3,
            "queryEngineTable": verified_table,
            "queryEngineVerified": True,
            "runId": "etl_run_verified",
            "status": "success",
        },
        "ds_parquet_output_verify",
        [["order_id", "string"]],
        "2026-07-11T00:00:00Z",
    )
    assert verified_parquet["queryEngineStatus"] == "available"
    assert verified_parquet["queryEngineTable"] == verified_table
    assert "SQL 분석" in verified_parquet["downstream"]


if __name__ == "__main__":
    verify()
    print("Query engine registration verification passed.")
