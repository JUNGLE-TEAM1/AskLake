from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.trino import SubmitTrinoQueryRunRequest
from app.services.trino_client import parse_trino_page
from app.services.trino_query_run_service import build_run_response, compile_trino_query


def make_dataset(dataset_id: str, name: str, table: str | None) -> CatalogDatasetResponse:
    payload: dict[str, object] = {
        "description": "Trino foundation verification dataset",
        "freshness": "latest",
        "id": dataset_id,
        "layer": "SILVER",
        "lastUpdated": "2026-07-10T00:00:00Z",
        "name": name,
        "nextRefresh": "-",
        "owner": "AskLake",
        "quality": "ready",
        "rag": False,
        "rows": "0",
        "sampleRows": [],
        "schema": [],
        "size": "0 B",
        "source": "Trino",
        "status": "available",
        "tags": [],
    }
    if table:
        payload["queryEngineTable"] = {
            "catalog": "iceberg",
            "schema": "asklake",
            "table": table,
            "format": "iceberg",
        }
    return CatalogDatasetResponse.model_validate(payload)


def verify() -> None:
    orders = make_dataset("ds_orders", "orders", "orders_clean")
    customers = make_dataset("ds_customers", "customers", "customers_clean")
    compiled = compile_trino_query(
        "SELECT o.order_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id",
        [orders, customers],
        [orders, customers],
    )
    assert 'FROM "iceberg"."asklake"."orders_clean" o' in compiled
    assert 'JOIN "iceberg"."asklake"."customers_clean" c' in compiled

    missing_mapping = make_dataset("ds_missing", "missing_map", None)
    try:
        compile_trino_query("SELECT * FROM missing_map", [missing_mapping], [missing_mapping])
    except ApiError as error:
        assert error.code == "VALIDATION_ERROR"
    else:
        raise AssertionError("missing Trino mapping should fail")

    page = parse_trino_page({
        "id": "20260710_000000_00001_test",
        "nextUri": "http://trino:8080/v1/statement/next",
        "columns": [{"name": "order_id"}],
        "stats": {"state": "RUNNING", "elapsedTimeMillis": 25, "processedRows": 3},
    })
    run = build_run_response(
        SubmitTrinoQueryRunRequest(baseDatasetId="ds_orders", query="SELECT * FROM orders"),
        page,
    )
    assert run.status == "running"
    assert run.stats and run.stats.processed_rows == 3
    assert run.result and run.result.columns == ["order_id"]


if __name__ == "__main__":
    verify()
    print("Trino Query Run foundation verification passed.")
