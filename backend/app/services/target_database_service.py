import os

from app.core.config import Settings, settings
from app.schemas.integration import TargetDatabaseOption, TargetDatabasesResponse


def list_target_databases(runtime_settings: Settings | None = None) -> TargetDatabasesResponse:
    active_settings = runtime_settings or settings
    configured = [
        name.strip()
        for name in (
            os.environ.get("TARGET_DATABASES")
            or os.environ.get("ASKLAKE_TARGET_DATABASES")
            or ""
        ).split(",")
        if name.strip()
    ]
    if not configured and active_settings.trino_schema.strip():
        configured = [active_settings.trino_schema.strip()]

    unique_names = list(dict.fromkeys(configured))
    return TargetDatabasesResponse(
        databases=[
            TargetDatabaseOption(
                description="Configured Trino/Iceberg target schema",
                name=name,
            )
            for name in unique_names
        ]
    )
