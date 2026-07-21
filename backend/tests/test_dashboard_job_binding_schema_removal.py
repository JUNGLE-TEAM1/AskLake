from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from sqlalchemy import create_engine, inspect, text


BACKEND_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_CONFIG = BACKEND_ROOT / "alembic.ini"
PREVIOUS_REVISION = "0021_dashboard_job_bindings"
REMOVAL_REVISION = "0022_remove_dashboard_job_bindings"
RETIRED_TABLES = {"dashboard_binding_deliveries", "dashboard_job_bindings"}


def _database_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path}"


def _run_alembic(
    path: Path,
    *arguments: str,
    confirm_drop: bool = False,
) -> subprocess.CompletedProcess[str]:
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
    if confirm_drop:
        environment["ASKLAKE_CONFIRM_DROP_DASHBOARD_JOB_BINDINGS"] = "true"
    completed = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ALEMBIC_CONFIG), *arguments],
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


class DashboardJobBindingSchemaRemovalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "binding-removal.sqlite"
        self.engine = create_engine(_database_url(self.database_path))

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_directory.cleanup()

    def test_fresh_head_has_no_retired_binding_tables(self) -> None:
        heads = _run_alembic(self.database_path, "heads").stdout
        self.assertEqual(heads.count("(head)"), 1)
        self.assertIn(REMOVAL_REVISION, heads)

        _run_alembic(self.database_path, "upgrade", "head")

        self.assertEqual(_revision(self.engine), REMOVAL_REVISION)
        self.assertTrue(RETIRED_TABLES.isdisjoint(inspect(self.engine).get_table_names()))

    def test_upgrade_drops_only_retired_tables_and_downgrade_restores_empty_schema(self) -> None:
        _run_alembic(self.database_path, "upgrade", PREVIOUS_REVISION)
        with self.engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO dashboard_job_bindings "
                    "(id, dashboard_id, job_id, job_kind, output_dataset_id, created_by) "
                    "VALUES ('binding-1', 'dashboard-1', 'job-1', 'etl', 'dataset-1', 'tester')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO dashboard_binding_deliveries "
                    "(id, binding_id, dataset_revision, mutation_type) "
                    "VALUES ('delivery-1', 'binding-1', 1, 'append')"
                )
            )
            connection.execute(
                text(
                    "CREATE TABLE dashboard_phase4_marker "
                    "(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO dashboard_phase4_marker (id, payload) "
                    "VALUES (1, 'preserve-me')"
                )
            )

        with self.assertRaisesRegex(
            AssertionError,
            "Refusing to drop populated Dashboard Job Binding tables",
        ):
            _run_alembic(self.database_path, "upgrade", "head")
        self.assertEqual(_revision(self.engine), PREVIOUS_REVISION)
        self.assertTrue(RETIRED_TABLES.issubset(inspect(self.engine).get_table_names()))

        _run_alembic(self.database_path, "upgrade", "head", confirm_drop=True)

        upgraded_tables = set(inspect(self.engine).get_table_names())
        self.assertEqual(_revision(self.engine), REMOVAL_REVISION)
        self.assertTrue(RETIRED_TABLES.isdisjoint(upgraded_tables))
        self.assertIn("dashboard_phase4_marker", upgraded_tables)
        with self.engine.connect() as connection:
            self.assertEqual(
                connection.execute(
                    text("SELECT payload FROM dashboard_phase4_marker WHERE id = 1")
                ).scalar_one(),
                "preserve-me",
            )

        _run_alembic(self.database_path, "downgrade", PREVIOUS_REVISION)

        downgraded_tables = set(inspect(self.engine).get_table_names())
        self.assertEqual(_revision(self.engine), PREVIOUS_REVISION)
        self.assertTrue(RETIRED_TABLES.issubset(downgraded_tables))
        with self.engine.connect() as connection:
            self.assertEqual(
                connection.execute(text("SELECT COUNT(*) FROM dashboard_job_bindings")).scalar_one(),
                0,
            )
            self.assertEqual(
                connection.execute(text("SELECT COUNT(*) FROM dashboard_binding_deliveries")).scalar_one(),
                0,
            )

        _run_alembic(self.database_path, "upgrade", "head")
        self.assertTrue(RETIRED_TABLES.isdisjoint(inspect(self.engine).get_table_names()))


if __name__ == "__main__":
    unittest.main()
