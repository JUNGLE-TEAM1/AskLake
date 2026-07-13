from __future__ import annotations

from time import sleep
from uuid import uuid4

from sqlalchemy import delete, select

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.models import AuditEventModel, CatalogDatasetModel, ETLJobModel, ETLRunModel, SqlRunModel, SqlRunResultPageModel
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.etl import CreateTrinoSqlJobRequest
from app.schemas.trino import SubmitTrinoQueryRunRequest
from app.services import etl_service
from app.services.trino_client import TrinoClient
from app.services.trino_query_run_service import TrinoQueryRunService
from app.services.trino_result_collector import TrinoResultCollector
from app.services.trino_result_storage import TrinoResultStorage


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def execute(client: TrinoClient, statement: str) -> list[list[object]]:
    page = client.submit(statement)
    rows = list(page.rows)
    pages = 0
    while page.next_uri and page.error is None:
        if pages >= 100:
            raise RuntimeError("TRINO_SQL_JOB_E2E_PAGE_LIMIT")
        page = client.fetch(page.next_uri)
        rows.extend(page.rows)
        pages += 1
    if page.error is not None:
        raise RuntimeError(f"{page.error.code}: {page.error.message}")
    return rows


def collect_until_terminal(
    collector: TrinoResultCollector,
    repository: SqlRepository,
    run_id: str,
    *,
    expected_engine: str,
) -> dict[str, object]:
    for _ in range(120):
        payload = repository.get_run_payload(run_id) or {}
        if payload.get("engine") == expected_engine and payload.get("status") in {"succeeded", "failed", "cancelled"}:
            if expected_engine != "trino-job-materialization" or payload.get("finalized") is True:
                return payload
        collector.collect_available(max_runs=20)
        sleep(0.05)
    raise RuntimeError(f"Run did not reach a terminal state: {run_id}")


def table_from_storage_location(value: object) -> str | None:
    parts = str(value or "").removeprefix("iceberg://").split("/")
    return parts[2] if len(parts) >= 3 else None


def main() -> None:
    if not settings.trino_enabled:
        raise RuntimeError("TRINO_ENABLED=true is required")

    suffix = uuid4().hex[:10]
    actor = ActorContext(
        id=f"user-sql-job-{suffix}",
        name=f"SQL Job E2E {suffix}",
        role="viewer",
        groups=("Data Engineer Group",),
    )
    other_actor = ActorContext(
        id=f"user-sql-job-other-{suffix}",
        name=f"SQL Job E2E Other {suffix}",
        role="viewer",
        groups=("Data Engineer Group",),
    )
    base_dataset_id = f"ds_sql_job_base_{suffix}"
    base_dataset_name = f"한글 주문 원본 {suffix}"
    base_table = f"sql_job_base_{suffix}"
    output_name = f"한글 주문 집계 {suffix}"
    source_run_id: str | None = None
    job_id: str | None = None
    generated_tables: set[str] = set()

    materializer = TrinoClient(
        settings,
        username=settings.trino_materializer_username,
        password=settings.trino_materializer_password,
    )
    qualified_schema = f"{quote_identifier(settings.trino_catalog)}.{quote_identifier(settings.trino_schema)}"
    qualified_base = f"{qualified_schema}.{quote_identifier(base_table)}"

    with SessionLocal() as db:
        sql_repository = SqlRepository(db)
        catalog_repository = CatalogRepository(db)
        result_storage = TrinoResultStorage(settings)
        collector = TrinoResultCollector(sql_repository, catalog_repository, settings, worker_id=f"sql-job-e2e-{suffix}")
        try:
            execute(materializer, f"CREATE SCHEMA IF NOT EXISTS {qualified_schema}")
            execute(materializer, f"DROP TABLE IF EXISTS {qualified_base}")
            execute(
                materializer,
                f"CREATE TABLE {qualified_base} WITH (format = 'PARQUET') AS "
                "SELECT * FROM (VALUES (1, 120), (2, 80), (3, 40)) AS t(order_id, amount)",
            )
            catalog_repository.save_dataset_payload({
                "description": "Trino SQL Job E2E base",
                "downstream": ["SQL 분석"],
                "freshness": "latest",
                "id": base_dataset_id,
                "layer": "RAW",
                "lastUpdated": "now",
                "name": base_dataset_name,
                "nextRefresh": "-",
                "owner": actor.name,
                "permissionGrants": [{
                    "actions": ["view", "query"],
                    "principalId": actor.id,
                    "principalType": "user",
                    "source": "e2e",
                }, {
                    "actions": ["view", "query"],
                    "principalId": other_actor.id,
                    "principalType": "user",
                    "source": "e2e",
                }],
                "permissions": {"canView": True, "canQuery": True},
                "quality": "verified",
                "queryEngineStatus": "available",
                "queryEngineTable": {
                    "catalog": settings.trino_catalog,
                    "format": "iceberg",
                    "partitionColumns": [],
                    "schema": settings.trino_schema,
                    "table": base_table,
                },
                "rag": False,
                "rows": "3 rows",
                "sampleRows": [],
                "schema": [["order_id", "integer"], ["amount", "integer"]],
                "size": "Trino managed",
                "source": "E2E",
                "status": "available",
                "storageFormat": "iceberg",
                "storageLocation": f"iceberg://{settings.trino_catalog}/{settings.trino_schema}/{base_table}",
                "storageSizeBytes": 0,
                "tags": ["#e2e"],
                "upstream": [],
            })

            query = f'SELECT order_id, TRY_CAST(amount AS BIGINT) AS amount FROM {quote_identifier(base_dataset_name)}'
            query_service = TrinoQueryRunService(sql_repository, catalog_repository, runtime_settings=settings)
            source_run = query_service.submit(
                SubmitTrinoQueryRunRequest(
                    baseDatasetId=base_dataset_id,
                    clientRequestId=f"sql-job-e2e-{suffix}",
                    query=query,
                    referenceDatasetIds=[],
                ),
                actor,
            )
            source_run_id = source_run.run_id
            source_payload = collect_until_terminal(
                collector,
                sql_repository,
                source_run_id,
                expected_engine="trino",
            )
            assert source_payload["status"] == "succeeded", source_payload

            create_request = CreateTrinoSqlJobRequest.model_validate({
                "baseDatasetId": base_dataset_id,
                "dataset": {
                    "description": "한글 이름을 유지하는 반복 SQL Dataset",
                    "layer": "GOLD",
                    "name": output_name,
                    "rag": False,
                    "refreshPolicy": "manual",
                    "tags": ["#sql-job", "#e2e"],
                },
                "governance": {
                    "accessScope": "private",
                    "owner": actor.name,
                    "permissionSummary": "owner only",
                },
                "jobName": f"{output_name} SQL Job",
                "query": query,
                "referenceDatasetIds": [],
                "schedule": {"mode": "manual"},
                "sourceRunId": source_run_id,
                "target": {"writeMode": "full_refresh"},
            })
            try:
                etl_service.create_trino_sql_job(db, create_request, other_actor)
                raise AssertionError("A different Query Run actor created the SQL Job")
            except ApiError as exc:
                assert exc.status_code == 403, exc

            created = etl_service.create_trino_sql_job(db, create_request, actor)
            job_id = created.job.id
            assert created.job.job_kind == "trino_sql_materialization"
            assert created.job.sql_recipe and created.job.sql_recipe["query"] == query

            physical_tables: list[str] = []
            for command in ("run", "run"):
                submitted = etl_service.command_job(db, job_id, command, actor)
                assert submitted.run is not None
                job_run_payload = collect_until_terminal(
                    collector,
                    sql_repository,
                    submitted.run.run_id,
                    expected_engine="trino-job-materialization",
                )
                assert job_run_payload["status"] == "succeeded", job_run_payload
                dataset = catalog_repository.get_dataset_payload(str(job_run_payload["datasetId"]))
                assert dataset and dataset["name"] == output_name
                assert dataset["queryEngineStatus"] == "available"
                assert len(dataset["materializationRuns"]) == len(physical_tables) + 1
                assert dataset["materializationRuns"][0]["runId"] == submitted.run.run_id
                physical_table = str(dataset["queryEngineTable"]["table"])
                generated_tables.add(physical_table)
                physical_tables.append(physical_table)

            assert physical_tables[0] != physical_tables[1], physical_tables
            stable_dataset = catalog_repository.get_dataset_payload(created.catalog_target["id"])
            assert stable_dataset and stable_dataset["queryEngineTable"]["table"] == physical_tables[-1]
            stable_mapping = dict(stable_dataset["queryEngineTable"])
            stable_run_count = len(stable_dataset["materializationRuns"])

            execute(materializer, f"DROP TABLE IF EXISTS {qualified_base}")
            failed_submission = etl_service.command_job(db, job_id, "run", actor)
            assert failed_submission.run is not None
            failed_payload = collect_until_terminal(
                collector,
                sql_repository,
                failed_submission.run.run_id,
                expected_engine="trino-job-materialization",
            )
            assert failed_payload["status"] == "failed", failed_payload
            preserved = catalog_repository.get_dataset_payload(created.catalog_target["id"])
            assert preserved and preserved["queryEngineTable"] == stable_mapping
            assert len(preserved["materializationRuns"]) == stable_run_count

            print("Trino SQL Job E2E verification passed.")
        finally:
            output_dataset_id = None
            if job_id:
                job = db.get(ETLJobModel, job_id)
                output_dataset_id = job.dataset_id if job else None
                if job:
                    for run in list((catalog_repository.get_dataset_payload(job.dataset_id) or {}).get("materializationRuns", [])):
                        table = table_from_storage_location(run.get("storageLocation"))
                        if table:
                            generated_tables.add(table)
            for table in generated_tables:
                try:
                    execute(materializer, f"DROP TABLE IF EXISTS {qualified_schema}.{quote_identifier(table)}")
                except Exception:
                    pass
            try:
                execute(materializer, f"DROP TABLE IF EXISTS {qualified_base}")
            except Exception:
                pass

            relevant_sql_models: list[SqlRunModel] = []
            if source_run_id:
                source_model = db.get(SqlRunModel, source_run_id)
                if source_model is not None:
                    relevant_sql_models.append(source_model)
            if job_id:
                relevant_sql_models.extend(db.scalars(
                    select(SqlRunModel).where(SqlRunModel.payload["jobId"].astext == job_id)
                ).all())
            relevant_sql_models = list({model.id: model for model in relevant_sql_models}.values())
            for model in relevant_sql_models:
                for page in sql_repository.list_result_pages(model.id):
                    if page.object_key:
                        result_storage.delete_object(page.object_key, suppress_errors=True)
                db.execute(delete(SqlRunResultPageModel).where(SqlRunResultPageModel.run_id == model.id))
                db.delete(model)
            if job_id:
                db.execute(delete(ETLRunModel).where(ETLRunModel.job_id == job_id))
                db.execute(delete(ETLJobModel).where(ETLJobModel.id == job_id))
            dataset_ids = [base_dataset_id, output_dataset_id]
            db.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id.in_([value for value in dataset_ids if value])))
            db.execute(delete(AuditEventModel).where(
                (AuditEventModel.actor_id == actor.id)
                | (AuditEventModel.target_id.in_([value for value in [base_dataset_id, output_dataset_id, job_id, source_run_id] if value]))
            ))
            db.commit()


if __name__ == "__main__":
    main()
