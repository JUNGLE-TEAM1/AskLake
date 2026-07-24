from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from app.core import schema_management
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.models.base import Base
from app.repositories import (
    audit_repository,
    catalog_deletion_repository,
    catalog_repository,
    continuous_sql_repository,
    dashboard_live_repository,
    governance_repository,
    permission_repository,
    realtime_event_repository,
    sql_repository_schema,
)
from app.services import auth_service, semantic_model_service


class RuntimeSchemaDdlGuardTests(unittest.TestCase):
    def test_disabled_runtime_schema_management_blocks_every_metadata_ddl_helper(self) -> None:
        helpers = (
            audit_repository.ensure_audit_event_table,
            catalog_deletion_repository.ensure_catalog_deletion_schema,
            catalog_repository.ensure_catalog_schema,
            continuous_sql_repository.ensure_continuous_sql_schema,
            dashboard_live_repository.ensure_dashboard_live_schema,
            governance_repository.ensure_governance_tables,
            permission_repository.ensure_permission_grant_table,
            realtime_event_repository.ensure_realtime_event_schema,
            sql_repository_schema.ensure_sql_schema,
            auth_service.ensure_auth_tables,
            semantic_model_service.ensure_semantic_schema,
            migrate_dashboard_schema,
        )

        with (
            patch.object(schema_management.settings, "startup_schema_management_enabled", False),
            patch.object(Base.metadata, "create_all") as create_all,
        ):
            for helper in helpers:
                with self.subTest(helper=helper.__module__ + "." + helper.__name__):
                    database = MagicMock()
                    bind = MagicMock()
                    bind.dialect.name = "postgresql"
                    database.get_bind.return_value = bind

                    result = helper(database)

                    if helper is migrate_dashboard_schema:
                        self.assertEqual(result, [])
                    bind.begin.assert_not_called()
                    database.execute.assert_not_called()
                    database.commit.assert_not_called()

        create_all.assert_not_called()

    def test_postgres_runtime_cannot_enable_ddl_without_explicit_runner_context(self) -> None:
        database = MagicMock()
        database.get_bind.return_value.dialect.name = "postgresql"

        with (
            patch.object(schema_management.settings, "startup_schema_management_enabled", True),
            self.assertRaisesRegex(RuntimeError, "explicit migration runner"),
        ):
            auth_service.ensure_auth_tables(database)

    def test_explicit_runner_context_can_prepare_postgres_metadata(self) -> None:
        database = MagicMock()
        bind = MagicMock()
        bind.dialect.name = "postgresql"
        database.get_bind.return_value = bind
        auth_service._schema_ready_bind_ids.discard(id(bind))

        with (
            patch.object(schema_management.settings, "startup_schema_management_enabled", False),
            patch.object(Base.metadata, "create_all") as create_all,
            schema_management.metadata_schema_bootstrap(),
        ):
            auth_service.ensure_auth_tables(database)

        create_all.assert_called_once()
