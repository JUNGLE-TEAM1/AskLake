from __future__ import annotations

import unittest

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.repositories.dashboard_card_repository import (
    get_dashboard_card,
    list_dashboard_cards,
)
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository


class DashboardRequestNoDdlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        with Session(self.engine) as db:
            migrate_dashboard_schema(db)
            db.execute(text("""
                INSERT INTO dashboards (
                    id,
                    payload,
                    name,
                    owner,
                    status,
                    has_published_revision,
                    created_at,
                    updated_at
                ) VALUES (
                    'dashboard-request',
                    '{}',
                    'Request dashboard',
                    'Admin User',
                    'draft',
                    0,
                    NULL,
                    NULL
                )
            """))
            db.commit()

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_dashboard_read_requests_do_not_execute_schema_ddl(self) -> None:
        statements: list[str] = []

        def capture_statement(
            _connection,
            _cursor,
            statement: str,
            _parameters,
            _context,
            _executemany,
        ) -> None:
            statements.append(statement.strip())

        event.listen(self.engine, "before_cursor_execute", capture_statement)
        try:
            with Session(self.engine) as db:
                cards = list_dashboard_cards(db)
                card = get_dashboard_card(db, "dashboard-request")
                runtime_meta = DashboardRuntimeRepository(db).get_dashboard_meta(
                    "dashboard-request"
                )
        finally:
            event.remove(self.engine, "before_cursor_execute", capture_statement)

        self.assertEqual([item.id for item in cards], ["dashboard-request"])
        self.assertIsNotNone(card)
        self.assertIsNotNone(runtime_meta)
        ddl_statements = [
            statement
            for statement in statements
            if statement.upper().startswith(("CREATE ", "ALTER ", "DROP "))
        ]
        self.assertEqual(ddl_statements, [])


if __name__ == "__main__":
    unittest.main()
