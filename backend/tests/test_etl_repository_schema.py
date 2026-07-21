from sqlalchemy import String, Text

from app.repositories.etl_schema_migrations import column_requires_text_migration


def test_text_columns_do_not_repeat_destructive_type_ddl() -> None:
    columns = {
        "already_text": {"type": Text()},
        "legacy_varchar": {"type": String(255)},
    }

    assert column_requires_text_migration(columns, "already_text") is False
    assert column_requires_text_migration(columns, "legacy_varchar") is True
    assert column_requires_text_migration(columns, "missing") is False
