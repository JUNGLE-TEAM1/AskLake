from app.core.database import SessionLocal
from app.core.schema_management import metadata_schema_bootstrap
from app.migrations.dashboard_schema import (
    applied_dashboard_schema_versions,
    migrate_dashboard_schema,
)


def main() -> None:
    with SessionLocal() as db:
        with metadata_schema_bootstrap():
            newly_applied = migrate_dashboard_schema(db)
        applied = sorted(applied_dashboard_schema_versions(db))
    if newly_applied:
        print(f"Applied Dashboard schema migrations: {', '.join(newly_applied)}")
    else:
        print("Dashboard schema is already current.")
    print(f"Dashboard schema versions: {', '.join(applied)}")


if __name__ == "__main__":
    main()
