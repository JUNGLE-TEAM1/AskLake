"""Small helpers for idempotent ETL schema widening migrations."""

from typing import Any, Iterable

from sqlalchemy import Text, text
from sqlalchemy.engine import Connection
from sqlalchemy.engine.reflection import Inspector


def columns_by_name(
    inspector: Inspector,
    table_name: str,
) -> dict[str, dict[str, Any]]:
    return {
        column["name"]: column
        for column in inspector.get_columns(table_name)
    }


def column_requires_text_migration(
    columns: dict[str, dict[str, Any]],
    name: str,
) -> bool:
    column = columns.get(name)
    return column is not None and not isinstance(column.get("type"), Text)


def migrate_columns_to_text(
    connection: Connection,
    table_name: str,
    columns: dict[str, dict[str, Any]],
    column_names: Iterable[str],
) -> None:
    for column_name in column_names:
        if column_requires_text_migration(columns, column_name):
            connection.execute(text(
                f"ALTER TABLE {table_name} ALTER COLUMN {column_name} TYPE TEXT"
            ))
