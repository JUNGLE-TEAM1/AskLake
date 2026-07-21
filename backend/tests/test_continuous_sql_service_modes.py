import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.continuous_sql import ContinuousSqlCreateRequest
from app.services.continuous_sql_service import (
    ContinuousSqlService,
    canonical_hash,
    compiled_plan_with_serving_mode,
)


class ContinuousSqlServiceModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        self.db = Session(self.engine)
        self.settings = Settings(
            _env_file=None,
            app_env="test",
            asklake_spark_output_bucket="asklake-output",
            continuous_sql_join_enabled=True,
            continuous_sql_serving_mode="iceberg",
        )
        self.service = ContinuousSqlService(self.db, runtime_settings=self.settings)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_backend_derives_append_iceberg_target_and_checkpoint(self) -> None:
        request = ContinuousSqlCreateRequest.model_validate({
            "query": "SELECT e.id FROM events e JOIN users u ON e.user_id = u.id",
            "relationDatasetIds": ["events", "users"],
            "name": "events users live join",
            "output": {
                "datasetId": "continuous-events-users",
                "datasetName": "events_users_live_join",
                "layer": "GOLD",
                "servingMode": "iceberg",
            },
        })

        target, storage_path, checkpoint_path = self.service._resolve_create_output(
            request,
            "csql-test",
        )

        self.assertEqual(target.catalog, self.settings.trino_catalog)
        self.assertEqual(target.namespace, self.settings.trino_schema)
        self.assertEqual(target.write_mode, "append")
        self.assertTrue(storage_path.startswith("s3a://asklake-output/continuous-sql/"))
        self.assertEqual(checkpoint_path, f"{storage_path}/_checkpoints/csql-test")

    def test_spark_paths_normalize_s3_scheme_to_s3a(self) -> None:
        request = ContinuousSqlCreateRequest.model_validate({
            "query": "SELECT e.id FROM events e JOIN users u ON e.user_id = u.id",
            "relationDatasetIds": ["events", "users"],
            "name": "events users live join",
            "output": {
                "datasetId": "continuous-events-users",
                "datasetName": "events_users_live_join",
                "layer": "GOLD",
                "servingMode": "iceberg",
                "storagePath": "s3://warehouse/continuous/events",
                "icebergTarget": {
                    "catalog": "iceberg",
                    "namespace": "asklake",
                    "table": "events_users_live_join",
                    "writeMode": "append",
                },
            },
            "checkpointPath": "s3://warehouse/checkpoints/events",
        })

        _target, storage_path, checkpoint_path = self.service._resolve_create_output(
            request,
            "csql-test",
        )

        self.assertEqual(storage_path, "s3a://warehouse/continuous/events")
        self.assertEqual(checkpoint_path, "s3a://warehouse/checkpoints/events")

    def test_serving_mode_is_included_in_the_runtime_plan_hash(self) -> None:
        plan = {
            "planVersion": "continuous-sql.v1",
            "runtimeSql": "SELECT 1",
            "planHash": "stale",
            "streamingSource": {
                "consumerGroupId": "shared-source-group",
                "topic": "events",
            },
        }

        resolved = compiled_plan_with_serving_mode(
            plan,
            "iceberg",
            job_id="csql-test",
            max_offsets_per_trigger=100,
        )

        self.assertEqual(resolved["servingMode"], "iceberg")
        self.assertEqual(
            resolved["streamingSource"]["consumerGroupId"],
            "asklake-continuous-sql-csql-test",
        )
        self.assertEqual(resolved["streamingSource"]["maxOffsetsPerTrigger"], 100)
        self.assertNotEqual(resolved["planHash"], "stale")
        self.assertEqual(
            resolved["planHash"],
            canonical_hash({key: value for key, value in resolved.items() if key != "planHash"}),
        )

    def test_dataset_revision_plan_does_not_retain_sql_kafka_ownership(self) -> None:
        resolved = compiled_plan_with_serving_mode(
            {
                "planVersion": "continuous-sql.v1",
                "runtimeSql": "SELECT 1",
                "streamingSource": {
                    "datasetId": "events",
                    "broker": "kafka:9092",
                    "topic": "events",
                    "consumerGroupId": "source-group",
                    "maxOffsetsPerTrigger": 100,
                },
            },
            "iceberg",
            job_id="csql-tree",
            max_offsets_per_trigger=100,
            execution_input_mode="dataset_revision",
        )

        self.assertEqual(resolved["executionInputMode"], "dataset_revision")
        self.assertEqual(resolved["streamingSource"], {"datasetId": "events"})

    def test_iceberg_deployment_rejects_clickhouse_job_creation(self) -> None:
        request = ContinuousSqlCreateRequest.model_validate({
            "query": "SELECT e.id FROM events e JOIN users u ON e.user_id = u.id",
            "relationDatasetIds": ["events", "users"],
            "name": "events users live join",
            "output": {
                "datasetId": "continuous-clickhouse",
                "datasetName": "events_users_clickhouse",
                "layer": "GOLD",
                "servingMode": "clickhouse",
                "clickhouseTarget": {
                    "engine": "clickhouse",
                    "database": "asklake",
                    "table": "events_users_clickhouse",
                },
            },
        })

        with self.assertRaises(ApiError) as caught:
            self.service.create(request, ActorContext(name="owner", role="admin"))

        self.assertEqual(caught.exception.code, "CONTINUOUS_SQL_SERVING_MODE_DISABLED")


if __name__ == "__main__":
    unittest.main()
