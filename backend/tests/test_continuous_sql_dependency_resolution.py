from __future__ import annotations

from types import SimpleNamespace
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.models.continuous_sql import ContinuousSqlDependencyModel
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.continuous_sql import (
    ContinuousSqlCreateRequest,
    ContinuousSqlDependencyBinding,
    ContinuousSqlPlanResponse,
)
from app.services.continuous_sql_catalog import ContinuousSqlCatalogResolver
from app.services.continuous_sql_planner import ContinuousSqlValidationError
from app.services.continuous_sql_service import ContinuousSqlService


def catalog_dataset(**overrides: object) -> CatalogDatasetResponse:
    payload = {
        "description": "fixture",
        "freshness": "latest",
        "id": "dataset-events",
        "layer": "SILVER",
        "lastUpdated": "2026-07-21T00:00:00Z",
        "name": "events",
        "nextRefresh": "manual",
        "owner": "owner",
        "quality": "passed",
        "rows": "1",
        "sampleRows": [],
        "schema": [["id", "string"]],
        "size": "1KB",
        "source": "Kafka",
        "status": "available",
        "tags": [],
        **overrides,
    }
    return CatalogDatasetResponse.model_validate(payload)


class FakeDb:
    def __init__(self, job: object | None) -> None:
        self.job = job

    def get(self, _model: object, job_id: str) -> object | None:
        if self.job is not None and getattr(self.job, "id", None) == job_id:
            return self.job
        return None


class ContinuousSqlProducerResolutionTests(unittest.TestCase):
    def test_relation_mode_is_required_and_never_inferred_from_legacy_fields(self) -> None:
        dataset = catalog_dataset(source="Kafka realtime", tags=["#실시간"])

        with self.assertRaises(ContinuousSqlValidationError) as raised:
            ContinuousSqlCatalogResolver._relation_mode(dataset)

        self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_RELATION_MODE_REQUIRED")

    def test_realtime_input_resolves_the_exact_catalog_producer(self) -> None:
        job = SimpleNamespace(
            id="JOB-KAFKA",
            dataset_id="dataset-events",
            job_kind="pipeline",
            execution_mode="continuous",
            source_type="Apache Kafka",
            source_config=[],
            status="running",
        )
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.db = FakeDb(job)
        dataset = catalog_dataset(
            relationMode="streaming",
            producerJobId="JOB-KAFKA",
            producerJobKind="pipeline",
            executionMode="continuous",
            sourceKind="kafka",
        )

        self.assertIs(resolver._producer_job(dataset, "streaming"), job)

    def test_realtime_input_without_exact_producer_is_rejected(self) -> None:
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.db = FakeDb(None)
        dataset = catalog_dataset(relationMode="streaming")

        with self.assertRaises(ContinuousSqlValidationError) as raised:
            resolver._producer_job(dataset, "streaming")

        self.assertEqual(
            raised.exception.code,
            "CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED",
        )

    def test_jobless_static_input_uses_snapshot_policy(self) -> None:
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.db = FakeDb(None)
        dataset = catalog_dataset(
            id="dataset-users",
            name="users",
            source="uploaded fixture",
            relationMode="static",
        )

        self.assertIsNone(resolver._producer_job(dataset, "static"))

    def test_static_dataset_with_snapshot_producer_is_a_batch_dependency(self) -> None:
        job = SimpleNamespace(
            id="JOB-SQL",
            dataset_id="dataset-users",
            job_kind="trino_sql_materialization",
            execution_mode="snapshot",
            source_type="SQL Result",
            source_config=[],
            status="scheduled",
        )
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.db = FakeDb(job)
        dataset = catalog_dataset(
            id="dataset-users",
            name="users",
            relationMode="static",
            producerJobId="JOB-SQL",
            producerJobKind="trino_sql_materialization",
            executionMode="snapshot",
            sourceKind="sql",
        )

        self.assertIs(resolver._producer_job(dataset, "static"), job)
        binding = ContinuousSqlService._dependency_bindings([
            SimpleNamespace(
                dataset_id=dataset.id,
                mode="static",
                producer_job_id=job.id,
            )
        ])[0]
        self.assertEqual(binding.input_type, "batch")
        self.assertEqual(binding.execution_policy, "run_on_tree_start")

    def test_legacy_direct_consumer_can_reuse_its_persisted_stream_binding(self) -> None:
        resolver = object.__new__(ContinuousSqlCatalogResolver)
        resolver.db = FakeDb(None)
        resolver.allow_clickhouse_streaming = False
        payload = catalog_dataset(
            queryEngineStatus="available",
            queryEngineTable={
                "catalog": "iceberg",
                "schema": "datasets",
                "table": "events",
                "format": "iceberg",
                "partitionColumns": [],
            },
        ).model_dump(mode="json", by_alias=True)
        dataset = CatalogDatasetResponse.model_validate(payload)

        relation = resolver._relation(
            payload,
            dataset,
            legacy_binding={
                "mode": "streaming",
                "streamingSource": {
                    "broker": "redpanda:9092",
                    "topic": "events",
                    "consumerGroupId": "legacy-direct-consumer",
                },
            },
        )

        self.assertEqual(relation.mode, "streaming")
        self.assertEqual(relation.streaming_source["topic"], "events")
        self.assertIsNone(relation.producer_job_id)


class ContinuousSqlCreateDependencyTests(unittest.TestCase):
    def test_create_commits_job_and_dependencies_together(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        settings = Settings(
            _env_file=None,
            app_env="test",
            asklake_spark_output_bucket="asklake-output",
            continuous_sql_join_enabled=True,
            continuous_sql_serving_mode="iceberg",
        )
        request = ContinuousSqlCreateRequest.model_validate({
            "query": "SELECT e.id FROM events e JOIN users u ON e.id = u.id",
            "relationDatasetIds": ["dataset-events", "dataset-users"],
            "name": "events users live join",
            "output": {
                "datasetId": "dataset-output",
                "datasetName": "events_users_live_join",
                "layer": "GOLD",
                "servingMode": "iceberg",
            },
        })
        compiled = ContinuousSqlPlanResponse(
            normalized_sql=request.query,
            plan_version="continuous-sql-v1",
            plan_hash="a" * 64,
            runtime_sql=request.query,
            relations=[],
            dependency_bindings=[
                ContinuousSqlDependencyBinding(
                    input_dataset_id="dataset-events",
                    child_job_id="JOB-KAFKA",
                    input_type="realtime",
                    execution_policy="run_on_tree_start",
                ),
                ContinuousSqlDependencyBinding(
                    input_dataset_id="dataset-users",
                    input_type="static",
                    execution_policy="reuse_snapshot",
                ),
            ],
            joins=[],
            output_schema=[["id", "string"]],
            static_binding_policy="PINNED_AT_START",
            compiled_plan={
                "planVersion": "continuous-sql-v1",
                "planHash": "a" * 64,
                "relations": [],
                "joins": [],
                "outputSchema": [["id", "string"]],
            },
        )
        try:
            with Session(engine) as db:
                service = ContinuousSqlService(db, runtime_settings=settings)
                service.catalog_repository = SimpleNamespace(
                    get_dataset_payload=lambda _dataset_id: None,
                )
                service._compile = lambda *_args, **_kwargs: compiled
                created = service.create(request, ActorContext(name="owner", role="admin"))
                job_id = created.id
                self.assertEqual(len(created.dependency_bindings), 2)
                self.assertTrue(all(item.sql_job_id == job_id for item in created.dependency_bindings))

            with Session(engine) as db:
                repository = ContinuousSqlRepository(db)
                self.assertIsNotNone(repository.get_job(job_id))
                dependencies = repository.list_dependencies(job_id)
                self.assertEqual(len(dependencies), 2)
                self.assertTrue(all(isinstance(item, ContinuousSqlDependencyModel) for item in dependencies))
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
