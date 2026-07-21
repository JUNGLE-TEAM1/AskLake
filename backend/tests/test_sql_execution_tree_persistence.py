from __future__ import annotations

from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session

from app.models.continuous_sql import (
    ContinuousSqlDependencyModel,
    ContinuousSqlJobModel,
)
from app.repositories.catalog_repository import (
    dataset_model_to_payload,
    dataset_payload_to_model_values,
)
from app.repositories.continuous_sql_repository import (
    ContinuousSqlRepository,
    job_to_schema,
)
from app.models.catalog import CatalogDatasetModel
from app.application.etl_catalog_projection import catalog_producer_metadata
from app.schemas.catalog import CatalogDatasetResponse
from tests.test_dashboard_job_binding_schema_removal import _run_alembic


HEAD_REVISION = "0024_sql_execution_tree_locking"
PREVIOUS_REVISION = "0022_remove_dashboard_job_bindings"
PRODUCER_COLUMNS = {
    "producer_job_id",
    "producer_job_kind",
    "execution_mode",
    "source_kind",
    "relation_mode",
    "runtime_status",
}


def continuous_job(job_id: str = "csql-phase1") -> ContinuousSqlJobModel:
    return ContinuousSqlJobModel(
        id=job_id,
        name="Phase 1 persistence",
        owner="owner",
        created_by="owner",
        original_sql="SELECT 1",
        normalized_sql="SELECT 1",
        plan_version="continuous-sql-v1",
        plan_hash="a" * 64,
        compiled_plan={},
        relation_bindings=[],
        static_binding_policy="PINNED_AT_START",
        trigger_interval_seconds=10,
        checkpoint_path="s3a://bucket/checkpoint",
        output_dataset_id="dataset-output",
        output_dataset_name="output",
        output_layer="GOLD",
        output_storage_path="s3a://bucket/output",
        output_target={
            "catalog": "iceberg",
            "namespace": "datasets",
            "table": "output",
            "format": "iceberg",
            "partitionColumns": [],
            "writeMode": "append",
        },
        desired_state="stopped",
        observed_state="stopped",
        generation=0,
    )


class SqlExecutionTreePersistenceTests(unittest.TestCase):
    def test_etl_publication_metadata_distinguishes_realtime_and_batch(self) -> None:
        realtime = catalog_producer_metadata(SimpleNamespace(
            id="JOB-KAFKA",
            job_kind="pipeline",
            execution_mode="continuous",
            source_type="Apache Kafka",
            source_config=[],
            status="running",
        ))
        batch = catalog_producer_metadata(SimpleNamespace(
            id="JOB-SQL",
            job_kind="trino_sql_materialization",
            execution_mode="snapshot",
            source_type="SQL Result",
            source_config=[],
            status="scheduled",
        ))

        self.assertEqual(realtime["sourceKind"], "kafka")
        self.assertEqual(realtime["relationMode"], "streaming")
        self.assertEqual(batch["sourceKind"], "sql")
        self.assertEqual(batch["relationMode"], "static")

    def test_dependency_rows_survive_a_new_session_and_are_exposed_on_job(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        try:
            with Session(engine) as db:
                repository = ContinuousSqlRepository(db)
                job = repository.add_job(continuous_job())
                repository.replace_dependencies(job.id, [
                    ContinuousSqlDependencyModel(
                        sql_job_id=job.id,
                        input_dataset_id="dataset-clicks",
                        child_job_id="JOB-KAFKA",
                        input_type="realtime",
                        execution_policy="run_on_tree_start",
                        required=True,
                    ),
                    ContinuousSqlDependencyModel(
                        sql_job_id=job.id,
                        input_dataset_id="dataset-users",
                        child_job_id=None,
                        input_type="static",
                        execution_policy="reuse_snapshot",
                        required=True,
                    ),
                ])
                db.commit()

            with Session(engine) as db:
                repository = ContinuousSqlRepository(db)
                job = repository.get_job("csql-phase1")
                self.assertIsNotNone(job)
                dependencies = repository.list_dependencies("csql-phase1")
                response = job_to_schema(job, dependencies=dependencies)

                self.assertEqual(len(response.dependency_bindings), 2)
                self.assertEqual(
                    response.dependency_bindings[0].input_dataset_id,
                    "dataset-clicks",
                )
                self.assertEqual(
                    response.dependency_bindings[1].execution_policy,
                    "reuse_snapshot",
                )
        finally:
            engine.dispose()

    def test_catalog_columns_override_legacy_payload_metadata(self) -> None:
        payload = {
            "id": "dataset-clicks",
            "name": "clicks",
            "description": "",
            "owner": "owner",
            "layer": "RAW",
            "status": "available",
            "freshness": "realtime",
            "source": "Kafka",
            "rows": "1",
            "size": "1",
            "quality": "passed",
            "lastUpdated": "2026-07-21T00:00:00Z",
            "nextRefresh": "-",
            "rag": False,
            "tags": [],
            "schema": [["id", "string"]],
            "sampleRows": [],
            "upstream": [],
            "downstream": [],
            "producerJobId": "stale-job",
        }
        model = CatalogDatasetModel(
            id="dataset-clicks",
            **dataset_payload_to_model_values(payload),
        )
        model.producer_job_id = "JOB-KAFKA"
        model.producer_job_kind = "pipeline"
        model.execution_mode = "continuous"
        model.source_kind = "kafka"
        model.relation_mode = "streaming"
        model.runtime_status = "running"

        normalized = dataset_model_to_payload(model)
        response = CatalogDatasetResponse.model_validate(normalized)

        self.assertEqual(normalized["producerJobId"], "JOB-KAFKA")
        self.assertEqual(normalized["executionMode"], "continuous")
        self.assertEqual(normalized["relationMode"], "streaming")
        self.assertEqual(normalized["runtimeStatus"], "running")
        self.assertEqual(response.producer_job_id, "JOB-KAFKA")
        self.assertEqual(response.model_dump(by_alias=True)["relationMode"], "streaming")


class SqlExecutionTreeMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "execution-tree.sqlite"
        self.engine = create_engine(f"sqlite+pysqlite:///{self.database_path}")

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_directory.cleanup()

    def test_upgrade_and_downgrade_are_additive_and_reversible(self) -> None:
        _run_alembic(self.database_path, "upgrade", PREVIOUS_REVISION)
        with self.engine.begin() as connection:
            connection.execute(text(
                "CREATE TABLE catalog_datasets (id TEXT PRIMARY KEY, payload JSON)"
            ))
            connection.execute(text(
                "CREATE TABLE continuous_sql_jobs (id VARCHAR(160) PRIMARY KEY)"
            ))
            connection.execute(text(
                "INSERT INTO catalog_datasets (id, payload) VALUES ('dataset-1', '{}')"
            ))
            connection.execute(text(
                "INSERT INTO continuous_sql_jobs (id) VALUES ('csql-1')"
            ))

        _run_alembic(self.database_path, "upgrade", "head")

        inspector = inspect(self.engine)
        self.assertEqual(
            self._revision(),
            HEAD_REVISION,
        )
        self.assertTrue(
            PRODUCER_COLUMNS.issubset({
                column["name"] for column in inspector.get_columns("catalog_datasets")
            })
        )
        self.assertIn("continuous_sql_dependencies", inspector.get_table_names())
        with self.engine.begin() as connection:
            connection.execute(text(
                "UPDATE catalog_datasets SET producer_job_id='JOB-1', "
                "producer_job_kind='pipeline', execution_mode='continuous', "
                "source_kind='kafka', relation_mode='streaming', runtime_status='running' "
                "WHERE id='dataset-1'"
            ))
            connection.execute(text(
                "INSERT INTO continuous_sql_dependencies "
                "(sql_job_id, input_dataset_id, child_job_id, input_type, execution_policy) "
                "VALUES ('csql-1', 'dataset-1', 'JOB-1', 'realtime', 'run_on_tree_start')"
            ))

        _run_alembic(self.database_path, "downgrade", PREVIOUS_REVISION)

        inspector = inspect(self.engine)
        self.assertNotIn("continuous_sql_dependencies", inspector.get_table_names())
        self.assertTrue(
            PRODUCER_COLUMNS.isdisjoint({
                column["name"] for column in inspector.get_columns("catalog_datasets")
            })
        )
        with self.engine.connect() as connection:
            self.assertEqual(
                connection.execute(text("SELECT COUNT(*) FROM catalog_datasets")).scalar_one(),
                1,
            )

    def _revision(self) -> str:
        with self.engine.connect() as connection:
            return str(
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
            )

    def test_upgrade_accepts_metadata_bootstrap_columns_before_alembic_revision(self) -> None:
        _run_alembic(self.database_path, "upgrade", PREVIOUS_REVISION)
        with self.engine.begin() as connection:
            connection.execute(text(
                "CREATE TABLE catalog_datasets (id TEXT PRIMARY KEY, payload JSON, "
                "producer_job_id VARCHAR(160), producer_job_kind VARCHAR(64), "
                "execution_mode VARCHAR(32), source_kind VARCHAR(64), "
                "relation_mode VARCHAR(32), runtime_status VARCHAR(64))"
            ))
            connection.execute(text(
                "CREATE TABLE continuous_sql_jobs (id VARCHAR(160) PRIMARY KEY)"
            ))

        _run_alembic(self.database_path, "upgrade", "head")

        self.assertEqual(self._revision(), HEAD_REVISION)
        inspector = inspect(self.engine)
        self.assertTrue(
            PRODUCER_COLUMNS.issubset({
                column["name"] for column in inspector.get_columns("catalog_datasets")
            })
        )
        self.assertIn("continuous_sql_dependencies", inspector.get_table_names())


if __name__ == "__main__":
    unittest.main()
