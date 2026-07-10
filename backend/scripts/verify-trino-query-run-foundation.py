from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.trino import QueryRunSubmitRequest, SubmitTrinoQueryRunRequest
from app.services.trino_client import parse_trino_page, validate_next_uri
from app.services.trino_query_run_service import build_run_response
from app.services.trino_sql_compiler import compile_trino_read_query
from app.services.trino_materialization import build_trino_materialization_statement


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
    canonical_request = QueryRunSubmitRequest(datasetId="ds_orders", query="SELECT * FROM orders")
    assert canonical_request.trino_request().base_dataset_id == "ds_orders"
    orders = make_dataset("ds_orders", "orders", "orders_clean")
    customers = make_dataset("ds_customers", "customers", "customers_clean")
    compiled, references = compile_trino_read_query(
        "SELECT o.order_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id",
        [orders, customers],
    )
    assert 'FROM "iceberg"."asklake"."orders_clean" AS o' in compiled
    assert 'JOIN "iceberg"."asklake"."customers_clean" AS c' in compiled
    assert [dataset.id for dataset in references] == ["ds_orders", "ds_customers"]

    comma_compiled, _ = compile_trino_read_query(
        "SELECT * FROM orders o, customers c WHERE o.customer_id = c.customer_id",
        [orders, customers],
    )
    assert '"iceberg"."asklake"."orders_clean" AS o' in comma_compiled
    assert '"iceberg"."asklake"."customers_clean" AS c' in comma_compiled

    missing_mapping = make_dataset("ds_missing", "missing_map", None)
    try:
        compile_trino_read_query("SELECT * FROM missing_map", [missing_mapping])
    except ApiError as error:
        assert error.code == "VALIDATION_ERROR"
    else:
        raise AssertionError("missing Trino mapping should fail")

    for unsafe_query in [
        "SELECT * FROM iceberg.asklake.orders_clean",
        "SELECT * FROM TABLE(system.query(query => 'SELECT 1'))",
    ]:
        try:
            compile_trino_read_query(unsafe_query, [orders, customers])
        except ApiError:
            pass
        else:
            raise AssertionError(f"unsafe SQL should fail: {unsafe_query}")

    page = parse_trino_page({
        "id": "20260710_000000_00001_test",
        "nextUri": "http://trino:8080/v1/statement/next",
        "columns": [{"name": "order_id"}],
        "stats": {"state": "RUNNING", "elapsedTimeMillis": 25, "processedRows": 3},
    })
    run = build_run_response(
        SubmitTrinoQueryRunRequest(baseDatasetId="ds_orders", query="SELECT * FROM orders"),
        page,
        actor=type("Actor", (), {"id": "user_1", "name": "Demo User"})(),
        retention_seconds=300,
    )
    assert run.status == "running"
    assert run.stats and run.stats.processed_rows == 3
    assert run.result and run.result.columns == ["order_id"]
    assert run.submitted_by_user_id == "user_1"

    completed_run = run.model_copy(update={"status": "succeeded"})
    materialization_sql = build_trino_materialization_statement(
        completed_run,
        orders.query_engine_table,
        'SELECT * FROM "iceberg"."asklake"."orders_clean"',
    )
    assert materialization_sql.startswith('CREATE TABLE "iceberg"."asklake"."orders_clean"')

    validate_next_uri("https://trino.internal:8443/v1/statement/next", "https://trino.internal:8443")
    try:
        validate_next_uri("http://127.0.0.1:8080/v1/statement/next", "https://trino.internal:8443")
    except ApiError:
        pass
    else:
        raise AssertionError("untrusted Trino continuation URL should fail")


if __name__ == "__main__":
    verify()
    print("Trino Query Run foundation verification passed.")
