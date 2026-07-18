from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError


BACKEND_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_CONFIG = BACKEND_ROOT / "alembic.ini"
V2_REVISION = "0017_catalog_realtime_publication"
PREVIOUS_REVISION = "0015_ai_generation_evidence_audit"
EXPECTED_V2_TABLES = {
    "realtime_dimension_versions",
    "realtime_ingest_exceptions",
    "realtime_materializations",
    "realtime_partition_checkpoints",
    "realtime_partition_receipt_ranges",
    "realtime_pipeline_deployments",
    "realtime_pipeline_versions",
    "realtime_pipelines",
    "realtime_routing_assignments",
    "realtime_unmatched_events",
}


def _database_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path}"


def _run_alembic(path: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    inherited_python_path = environment.get("PYTHONPATH", "").strip()
    python_path = str(BACKEND_ROOT)
    if inherited_python_path:
        python_path = f"{python_path}{os.pathsep}{inherited_python_path}"
    environment.update(
        {
            "APP_ENV": "test",
            "DATABASE_URL": _database_url(path),
            "PYTHONPATH": python_path,
        }
    )
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(ALEMBIC_CONFIG),
            *arguments,
        ],
        cwd=BACKEND_ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "Alembic command failed: "
            f"{' '.join(arguments)}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return completed


def _revision(engine) -> str:
    with engine.connect() as connection:
        return str(connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one())


class ClickHouseRealtimeAlembicTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "asklake-migration.sqlite"
        self.engine = create_engine(_database_url(self.database_path))

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_directory.cleanup()

    def test_fresh_upgrade_is_single_head_and_repeatable(self) -> None:
        heads = _run_alembic(self.database_path, "heads").stdout
        self.assertIn(f"{V2_REVISION} (head)", heads)
        self.assertEqual(heads.count("(head)"), 1)

        _run_alembic(self.database_path, "upgrade", "head")
        inspector = inspect(self.engine)
        self.assertEqual(_revision(self.engine), V2_REVISION)
        self.assertTrue(EXPECTED_V2_TABLES.issubset(inspector.get_table_names()))
        self.assertNotIn("dataset_serving_revisions", inspector.get_table_names())

        pipeline_columns = {
            column["name"] for column in inspector.get_columns("realtime_pipelines")
        }
        self.assertTrue(
            {
                "scope_id",
                "logical_dataset_id",
                "execution_mode",
                "active_version_id",
            }.issubset(pipeline_columns)
        )
        checkpoint_columns = {
            column["name"]
            for column in inspector.get_columns("realtime_partition_checkpoints")
        }
        self.assertIn("last_contiguously_received_offset", checkpoint_columns)
        unmatched_primary_key = inspector.get_pk_constraint(
            "realtime_unmatched_events"
        )["constrained_columns"]
        self.assertEqual(
            unmatched_primary_key,
            [
                "pipeline_version_id",
                "source_position_hash",
                "missing_dimension_dataset_id",
            ],
        )
        materialization_uniques = {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("realtime_materializations")
        }
        self.assertIn(
            "uq_realtime_materializations_source_fingerprint",
            materialization_uniques,
        )
        active_dimension_indexes = {
            index["name"]: index
            for index in inspector.get_indexes("realtime_dimension_versions")
        }
        self.assertTrue(
            active_dimension_indexes[
                "uq_realtime_dimension_versions_active_dataset"
            ]["unique"]
        )
        active_pipeline_indexes = {
            index["name"]: index
            for index in inspector.get_indexes("realtime_pipeline_versions")
        }
        self.assertTrue(
            active_pipeline_indexes[
                "uq_realtime_pipeline_versions_one_active"
            ]["unique"]
        )

        with self.engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO realtime_pipelines
                        (id, logical_dataset_id, name, execution_mode, owner_user_id)
                    VALUES
                        ('rtp_repeat', 'dataset_repeat', 'repeat guard',
                         'realtime_incremental', 'migration-test')
                    """
                )
            )
            connection.execute(
                text(
                    """
                    INSERT INTO realtime_routing_assignments
                        (resource_type, resource_id, desired_engine,
                         assignment_reason, assigned_by)
                    VALUES
                        ('dataset', 'dataset_pending', 'clickhouse',
                         'awaiting shadow evidence', 'migration-test')
                    """
                )
            )
            connection.execute(
                text(
                    """
                    INSERT INTO realtime_pipeline_versions
                        (id, pipeline_id, version, pipeline_generation,
                         normalized_sql, sql_fingerprint, source_dataset_id,
                         schema_fingerprint, status, created_by)
                    VALUES
                        ('rtpv_active', 'rtp_repeat', 1, 1, 'SELECT 1',
                         'sql-fingerprint-1', 'dataset_source',
                         'schema-fingerprint-1', 'active', 'migration-test')
                    """
                )
            )
            connection.execute(
                text(
                    """
                    INSERT INTO realtime_materializations
                        (id, pipeline_version_id, source_boundary,
                         source_fingerprint, clickhouse_query_id,
                         lease_generation, target_row_count, target_checksum,
                         status, committed_at)
                    VALUES
                        ('rtm_materialized', 'rtpv_active', '{}',
                         'source-fingerprint-materialized',
                         'query-materialized', 1, 1, 'checksum-1',
                         'materialized', CURRENT_TIMESTAMP)
                    """
                )
            )

        with self.assertRaises(IntegrityError):
            with self.engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO realtime_pipeline_versions
                            (id, pipeline_id, version, pipeline_generation,
                             normalized_sql, sql_fingerprint, source_dataset_id,
                             schema_fingerprint, status, created_by)
                        VALUES
                            ('rtpv_second_active', 'rtp_repeat', 2, 2, 'SELECT 2',
                             'sql-fingerprint-2', 'dataset_source',
                             'schema-fingerprint-2', 'active', 'migration-test')
                        """
                    )
                )

        with self.assertRaises(IntegrityError):
            with self.engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO realtime_materializations
                            (id, pipeline_version_id, source_boundary,
                             source_fingerprint, clickhouse_query_id,
                             lease_generation, target_row_count, target_checksum,
                             status, committed_at)
                        VALUES
                            ('rtm_unpublished', 'rtpv_active', '{}',
                             'source-fingerprint-unpublished',
                             'query-unpublished', 1, 1, 'checksum-2',
                             'published', CURRENT_TIMESTAMP)
                        """
                    )
                )

        with self.assertRaises(IntegrityError):
            with self.engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO realtime_routing_assignments
                            (resource_type, resource_id, desired_engine, status,
                             assignment_reason, assigned_by)
                        VALUES
                            ('dataset', 'dataset_invalid_active', 'clickhouse',
                             'active', 'missing pipeline version', 'migration-test')
                        """
                    )
                )

        with self.engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO realtime_materializations
                        (id, pipeline_version_id, source_boundary,
                         source_fingerprint, clickhouse_query_id,
                         lease_generation, target_row_count, target_checksum,
                         status, committed_at, published_revision)
                    VALUES
                        ('rtm_published', 'rtpv_active', '{}',
                         'source-fingerprint-published', 'query-published',
                         1, 1, 'checksum-3', 'published', CURRENT_TIMESTAMP, 1)
                    """
                )
            )
            connection.execute(
                text(
                    """
                    INSERT INTO realtime_routing_assignments
                        (resource_type, resource_id, desired_engine,
                         pipeline_version_id, status, assignment_reason,
                         assigned_by)
                    VALUES
                        ('dataset', 'dataset_active', 'clickhouse',
                         'rtpv_active', 'active', 'shadow verified',
                         'migration-test')
                    """
                )
            )

        _run_alembic(self.database_path, "upgrade", "head")
        self.assertEqual(_revision(self.engine), V2_REVISION)
        with self.engine.connect() as connection:
            self.assertEqual(
                connection.execute(
                    text(
                        "SELECT COUNT(*) FROM realtime_pipelines "
                        "WHERE id = 'rtp_repeat'"
                    )
                ).scalar_one(),
                1,
            )

    def test_current_upgrade_and_development_downgrade_preserve_prior_schema(self) -> None:
        _run_alembic(self.database_path, "upgrade", PREVIOUS_REVISION)
        self.assertEqual(_revision(self.engine), PREVIOUS_REVISION)
        with self.engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE existing_runtime_marker "
                    "(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO existing_runtime_marker (id, payload) "
                    "VALUES (1, 'preserve-me')"
                )
            )

        _run_alembic(self.database_path, "upgrade", "head")
        self.assertEqual(_revision(self.engine), V2_REVISION)
        self.assertTrue(EXPECTED_V2_TABLES.issubset(inspect(self.engine).get_table_names()))

        _run_alembic(self.database_path, "downgrade", PREVIOUS_REVISION)
        downgraded_tables = set(inspect(self.engine).get_table_names())
        self.assertEqual(_revision(self.engine), PREVIOUS_REVISION)
        self.assertTrue(EXPECTED_V2_TABLES.isdisjoint(downgraded_tables))
        self.assertIn("semantic_models", downgraded_tables)
        self.assertIn("existing_runtime_marker", downgraded_tables)
        with self.engine.connect() as connection:
            self.assertEqual(
                connection.execute(
                    text("SELECT payload FROM existing_runtime_marker WHERE id = 1")
                ).scalar_one(),
                "preserve-me",
            )

        _run_alembic(self.database_path, "upgrade", "head")
        self.assertEqual(_revision(self.engine), V2_REVISION)
        upgraded_again_tables = set(inspect(self.engine).get_table_names())
        self.assertTrue(EXPECTED_V2_TABLES.issubset(upgraded_again_tables))
        self.assertIn("existing_runtime_marker", upgraded_again_tables)


if __name__ == "__main__":
    unittest.main()
