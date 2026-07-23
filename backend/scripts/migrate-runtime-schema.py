#!/usr/bin/env python3
"""One-shot metadata schema preparation for deployed control-plane services."""

from app.core.database import SessionLocal
from app.migrations.metadata_schema import bootstrap_metadata_schema
from app.services.auth_service import initialize_auth


def main() -> None:
    with SessionLocal() as db:
        bootstrap_metadata_schema(db)
        initialize_auth(db)


if __name__ == "__main__":
    main()
