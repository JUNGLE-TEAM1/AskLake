"""Compatibility facade for SQL run, result page, and collector persistence."""

from sqlalchemy.orm import Session

from app.repositories.sql_repository_schema import ensure_sql_schema, string_or_none
from app.repositories.sql_repository_types import TrinoCollectorClaim, TrinoSubmissionReservation
from app.repositories.sql_result_page_repository import SqlResultPageRepository
from app.repositories.sql_run_repository import SqlRunRepository
from app.repositories.trino_collector_repository import TrinoCollectorRepository


class SqlRepository(SqlRunRepository, SqlResultPageRepository, TrinoCollectorRepository):
    """Stable entrypoint while each persistence concern lives in its own module."""

    def __init__(self, db: Session) -> None:
        self.db = db


__all__ = [
    "SqlRepository",
    "TrinoCollectorClaim",
    "TrinoSubmissionReservation",
    "ensure_sql_schema",
    "string_or_none",
]
