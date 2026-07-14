import os

from app.schemas.integration import TargetDatabaseOption, TargetDatabasesResponse


DEFAULT_TARGET_DATABASES = [
    TargetDatabaseOption(description="AskLake catalog database", name="asklake"),
    TargetDatabaseOption(description="Gold dataset target database", name="asklake_gold"),
    TargetDatabaseOption(description="Analytics data mart database", name="analytics"),
    TargetDatabaseOption(description="Marketing customer data database", name="marketing"),
]


def list_target_databases() -> TargetDatabasesResponse:
    configured = [
        name.strip()
        for name in (
            os.environ.get("TARGET_DATABASES")
            or os.environ.get("ASKLAKE_TARGET_DATABASES")
            or ""
        ).split(",")
        if name.strip()
    ]
    if not configured:
        return TargetDatabasesResponse(databases=DEFAULT_TARGET_DATABASES)
    return TargetDatabasesResponse(
        databases=[
            TargetDatabaseOption(
                description="Configured by environment variable",
                name=name,
            )
            for name in configured
        ]
    )
