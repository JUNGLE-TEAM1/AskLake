from app.core.database import SessionLocal
from app.migrations.metadata_schema import bootstrap_metadata_schema


def main() -> None:
    with SessionLocal() as db:
        result = bootstrap_metadata_schema(db)
    if result.dashboard_versions:
        print(f"Applied Dashboard schema migrations: {', '.join(result.dashboard_versions)}")
    else:
        print("Metadata schema is already current.")
    print("Metadata schema bootstrap completed.")


if __name__ == "__main__":
    main()
