import argparse
import json
import time

from app.core.config import settings
from app.core.database import SessionLocal
from app.repositories.sql_repository import SqlRepository
from app.services.trino_result_cleanup_service import TrinoResultCleanupService
from app.services.trino_result_storage import TrinoResultStorage


def cleanup_once() -> None:
    with SessionLocal() as db:
        summary = TrinoResultCleanupService(
            SqlRepository(db),
            TrinoResultStorage(),
        ).cleanup_expired()
    print(json.dumps(summary.__dict__, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    while True:
        cleanup_once()
        if not args.loop:
            return
        time.sleep(settings.trino_cleanup_poll_seconds)


if __name__ == "__main__":
    main()
