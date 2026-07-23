import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy import String, Text

from app import main
from app.migrations.metadata_schema import bootstrap_metadata_schema
from app.repositories import etl_repository


class MetadataSchemaBootstrapTests(unittest.TestCase):
    def test_etl_repository_skips_runtime_ddl_when_schema_management_is_disabled(self) -> None:
        database = MagicMock()
        bind = MagicMock()
        database.get_bind.return_value = bind
        etl_repository._schema_ready_bind_ids.discard(id(bind))

        with patch.object(etl_repository.settings, "startup_schema_management_enabled", False):
            etl_repository.ensure_schema(database)

        bind.begin.assert_not_called()

    def test_postgres_repository_access_cannot_start_runtime_schema_ddl(self) -> None:
        database = MagicMock()
        bind = MagicMock()
        bind.dialect.name = "postgresql"
        database.get_bind.return_value = bind
        etl_repository._schema_ready_bind_ids.discard(id(bind))

        with (
            patch.object(etl_repository.settings, "startup_schema_management_enabled", True),
            self.assertRaisesRegex(RuntimeError, "not bootstrapped"),
        ):
            etl_repository.ensure_schema(database)

        bind.begin.assert_not_called()

    def test_text_columns_skip_noop_type_migration(self) -> None:
        self.assertFalse(etl_repository._column_needs_text_migration({"type": Text()}))
        self.assertTrue(etl_repository._column_needs_text_migration({"type": String(128)}))

    def test_bootstrap_owns_metadata_schema_preparation(self) -> None:
        database = object()
        with (
            patch("app.migrations.metadata_schema.migrate_dashboard_schema", return_value=["dashboard-v1"]) as dashboard,
            patch("app.migrations.metadata_schema.ensure_dashboard_live_schema") as dashboard_live,
            patch("app.migrations.metadata_schema.ensure_realtime_event_schema") as realtime,
            patch("app.migrations.metadata_schema.ensure_continuous_sql_schema") as continuous_sql,
            patch("app.migrations.metadata_schema.ensure_catalog_deletion_schema") as catalog_deletion,
            patch("app.migrations.metadata_schema.etl_repository.ensure_schema") as etl,
            patch("app.migrations.metadata_schema.ensure_sql_schema") as sql,
        ):
            result = bootstrap_metadata_schema(database)

        self.assertEqual(result.dashboard_versions, ("dashboard-v1",))
        dashboard.assert_called_once_with(database)
        dashboard_live.assert_called_once_with(database)
        realtime.assert_called_once_with(database)
        continuous_sql.assert_called_once_with(database)
        catalog_deletion.assert_called_once_with(database)
        etl.assert_called_once_with(database, bootstrap=True)
        sql.assert_called_once_with(database)

    def test_startup_bootstraps_metadata_before_initializing_auth(self) -> None:
        database = MagicMock()
        database.get_bind.return_value = object()

        with (
            patch("app.main.SessionLocal") as session_local,
            patch("app.main.bootstrap_metadata_schema") as bootstrap,
            patch("app.main.initialize_auth") as initialize_auth,
            patch.object(main.settings, "startup_schema_management_enabled", True),
        ):
            session_local.return_value.__enter__.return_value = database
            main.initialize_auth_on_startup()

        bootstrap.assert_called_once_with(database)
        initialize_auth.assert_called_once_with(database)
