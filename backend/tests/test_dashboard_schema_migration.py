from __future__ import annotations

import json
import unittest

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session

from app.migrations.dashboard_schema import (
    DASHBOARD_SCHEMA_VERSION,
    DASHBOARD_SCHEMA_VERSIONS,
    applied_dashboard_schema_versions,
    migrate_dashboard_schema,
)


EXPECTED_DASHBOARD_TABLES = {
    "dashboard_batch_widget_results",
    "dashboard_pages",
    "dashboard_revisions",
    "dashboard_schema_migrations",
    "dashboard_tags",
    "dashboard_widgets",
    "dashboards",
}


class DashboardSchemaMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_empty_database_is_prepared_once(self) -> None:
        with Session(self.engine) as db:
            first = migrate_dashboard_schema(db)
            second = migrate_dashboard_schema(db)
            versions = applied_dashboard_schema_versions(db)

        self.assertEqual(first, list(DASHBOARD_SCHEMA_VERSIONS))
        self.assertEqual(second, [])
        self.assertEqual(versions, set(DASHBOARD_SCHEMA_VERSIONS))
        self.assertIn(DASHBOARD_SCHEMA_VERSION, versions)
        self.assertTrue(
            EXPECTED_DASHBOARD_TABLES.issubset(set(inspect(self.engine).get_table_names()))
        )

    def test_existing_dashboard_row_is_preserved_and_backfilled(self) -> None:
        legacy_payload = {
            "name": "Legacy dashboard",
            "owner": "Legacy Owner",
            "status": "published",
            "datasetId": "dataset-legacy",
            "sourceRunId": "run-legacy",
            "publishedRevisionId": "revision-legacy",
            "hasPublishedRevision": True,
        }
        with self.engine.begin() as connection:
            connection.execute(text("""
                CREATE TABLE dashboards (
                    id TEXT PRIMARY KEY,
                    payload JSON NOT NULL DEFAULT '{}',
                    created_at DATETIME,
                    updated_at DATETIME
                )
            """))
            connection.execute(
                text("""
                    INSERT INTO dashboards (id, payload, created_at, updated_at)
                    VALUES (:id, :payload, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """),
                {
                    "id": "dashboard-legacy",
                    "payload": json.dumps(legacy_payload),
                },
            )

        with Session(self.engine) as db:
            applied = migrate_dashboard_schema(db)
            row = db.execute(text("""
                SELECT
                    id,
                    name,
                    owner,
                    status,
                    dataset_id,
                    source_run_id,
                    published_revision_id,
                    has_published_revision
                FROM dashboards
                WHERE id = 'dashboard-legacy'
            """)).mappings().one()

        self.assertEqual(applied, list(DASHBOARD_SCHEMA_VERSIONS))
        self.assertEqual(row["id"], "dashboard-legacy")
        self.assertEqual(row["name"], "Legacy dashboard")
        self.assertEqual(row["owner"], "Legacy Owner")
        self.assertEqual(row["status"], "published")
        self.assertEqual(row["dataset_id"], "dataset-legacy")
        self.assertEqual(row["source_run_id"], "run-legacy")
        self.assertEqual(row["published_revision_id"], "revision-legacy")
        self.assertEqual(row["has_published_revision"], 1)

if __name__ == "__main__":
    unittest.main()
