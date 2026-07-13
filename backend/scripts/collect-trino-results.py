import argparse
import json
import time

from app.core.config import settings
from app.core.database import SessionLocal
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.services.trino_result_collector import TrinoResultCollector


def collect_once() -> dict[str, int]:
    with SessionLocal() as db:
        collector = TrinoResultCollector(
            repository=SqlRepository(db),
            catalog_repository=CatalogRepository(db),
        )
        return collector.collect_available().__dict__


def main() -> None:
    parser = argparse.ArgumentParser(description="Drain durable Trino Query Run continuations.")
    parser.add_argument("--once", action="store_true", help="Claim available runs once, then exit.")
    args = parser.parse_args()
    while True:
        print(json.dumps(collect_once(), ensure_ascii=False), flush=True)
        if args.once:
            return
        time.sleep(settings.trino_collector_poll_seconds)


if __name__ == "__main__":
    main()
