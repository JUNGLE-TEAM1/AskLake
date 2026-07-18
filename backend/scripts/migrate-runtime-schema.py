#!/usr/bin/env python3
"""One-shot metadata schema preparation for deployed control-plane services."""

from app.core.database import SessionLocal
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.repositories.continuous_sql_repository import ensure_continuous_sql_schema
from app.repositories.dashboard_live_repository import ensure_dashboard_live_schema
from app.repositories.etl_repository import ensure_schema
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.services.auth_service import initialize_auth


def main() -> None:
    with SessionLocal() as db:
        ensure_schema(db)
        migrate_dashboard_schema(db)
        ensure_dashboard_live_schema(db)
        ensure_realtime_event_schema(db)
        ensure_continuous_sql_schema(db)
        initialize_auth(db)


if __name__ == "__main__":
    main()
