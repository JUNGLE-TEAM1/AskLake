from app.core.database import SessionLocal
from app.migrations.metadata_schema import bootstrap_metadata_schema


def main() -> None:
    with SessionLocal() as db:
        bootstrap_metadata_schema(db)


if __name__ == "__main__":
    main()
