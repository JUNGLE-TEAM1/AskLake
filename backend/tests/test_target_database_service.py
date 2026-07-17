from app.core.config import Settings
from app.services.target_database_service import list_target_databases


def test_target_databases_use_only_configured_names(monkeypatch) -> None:
    monkeypatch.setenv("ASKLAKE_TARGET_DATABASES", "asklake, analytics,asklake")

    result = list_target_databases(Settings(trino_schema="ignored"))

    assert [database.name for database in result.databases] == ["asklake", "analytics"]


def test_target_databases_default_to_the_configured_trino_schema(monkeypatch) -> None:
    monkeypatch.delenv("TARGET_DATABASES", raising=False)
    monkeypatch.delenv("ASKLAKE_TARGET_DATABASES", raising=False)

    result = list_target_databases(Settings(trino_schema="production_schema"))

    assert [database.name for database in result.databases] == ["production_schema"]
    assert all("Configured" in database.description for database in result.databases)
