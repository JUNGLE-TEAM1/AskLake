import json

from app.core.database import SessionLocal
from app.repositories.sql_repository import SqlRepository
from app.services.trino_result_cleanup_service import TrinoResultCleanupService
from app.services.trino_result_storage import TrinoResultStorage


def main() -> None:
    with SessionLocal() as db:
        summary = TrinoResultCleanupService(
            SqlRepository(db),
            TrinoResultStorage(),
        ).cleanup_expired()
    print(json.dumps(summary.__dict__, ensure_ascii=False))


if __name__ == "__main__":
    main()
