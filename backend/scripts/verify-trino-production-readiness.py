import argparse
import json
from uuid import uuid4

from app.core.config import settings
from app.core.errors import ApiError
from app.services.trino_client import TrinoClient
from app.services.trino_result_storage import TrinoResultStorage


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def execute(client: TrinoClient, statement: str) -> list[list[object]]:
    page = client.submit(statement)
    rows = list(page.rows)
    page_count = 0
    while page.next_uri and page.error is None:
        if page_count >= 100:
            raise RuntimeError("TRINO_READINESS_PAGE_LIMIT")
        page = client.fetch(page.next_uri)
        rows.extend(page.rows)
        page_count += 1
    if page.error is not None:
        raise RuntimeError(f"{page.error.code}: {page.error.message}")
    return rows


def main(*, allow_disabled: bool = False) -> None:
    if not settings.trino_enabled:
        if allow_disabled:
            print(json.dumps({"ok": True, "skipped": "TRINO_ENABLED=false"}))
            return
        raise RuntimeError("TRINO_ENABLED must be true for production readiness verification")
    production = settings.app_env.casefold() == "production"
    if production:
        if not settings.trino_base_url.startswith("https://") or not settings.trino_tls_ca_file:
            raise RuntimeError("Production Trino requires HTTPS and TRINO_TLS_CA_FILE")
        if not settings.trino_auth_username or not settings.trino_auth_password:
            raise RuntimeError("Production Trino query credentials are required")
        if not settings.trino_materializer_username or not settings.trino_materializer_password:
            raise RuntimeError("Production Trino materializer credentials are required")
        if settings.trino_auth_username == settings.trino_materializer_username:
            raise RuntimeError("Query and materializer Trino identities must be separate")
        if settings.asklake_object_storage_provider == "aws":
            if settings.trino_result_storage_access_key or settings.trino_result_storage_secret_key:
                raise RuntimeError("AWS query result storage must use the EC2 IAM Role")
        else:
            if not settings.trino_result_storage_access_key or not settings.trino_result_storage_secret_key:
                raise RuntimeError("Dedicated MinIO query result storage credentials are required")
            if settings.trino_result_storage_access_key == settings.minio_access_key:
                raise RuntimeError("Query result storage must not use the MinIO root identity")

    query_client = TrinoClient(settings)
    materializer = TrinoClient(
        settings,
        username=settings.trino_materializer_username,
        password=settings.trino_materializer_password,
    )
    catalog = quote_identifier(settings.trino_catalog)
    schema = quote_identifier(settings.trino_schema)
    table_name = f"readiness_{uuid4().hex[:12]}"
    table = f"{catalog}.{schema}.{quote_identifier(table_name)}"
    read_only_table = f"{catalog}.{schema}.{quote_identifier(f'readonly_{uuid4().hex[:12]}')}"

    execute(query_client, "SELECT 1")
    execute(materializer, f"CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}")
    read_only_enforced = False
    if production:
        try:
            execute(query_client, f"CREATE TABLE {read_only_table} AS SELECT 1 AS forbidden_value")
        except (ApiError, RuntimeError):
            read_only_enforced = True
        else:
            execute(materializer, f"DROP TABLE IF EXISTS {read_only_table}")
            raise RuntimeError("Query identity unexpectedly has materialization privileges")

    try:
        execute(materializer, f"CREATE TABLE {table} WITH (format = 'PARQUET') AS SELECT 1 AS readiness_value")
        describe_rows = execute(materializer, f"DESCRIBE {table}")
        if not describe_rows:
            raise RuntimeError("TRINO_READINESS_EMPTY_SCHEMA")
    finally:
        try:
            execute(materializer, f"DROP TABLE IF EXISTS {table}")
        except (ApiError, RuntimeError):
            pass

    result_storage = TrinoResultStorage(settings)
    result_run_id = f"trino_{uuid4().hex[:12]}"
    stored_page = result_storage.write_page(
        run_id=result_run_id,
        page_index=0,
        columns=["readiness_value"],
        rows=[[1]],
    )
    try:
        columns, rows = result_storage.read_page(
            object_key=stored_page.object_key,
            expected_checksum=stored_page.checksum,
        )
        if columns != ["readiness_value"] or rows != [[1]]:
            raise RuntimeError("Query result storage round trip returned unexpected data")
    finally:
        result_storage.delete_object(stored_page.object_key, suppress_errors=True)

    print(json.dumps({
        "catalog": settings.trino_catalog,
        "ok": True,
        "queryIdentityReadOnly": read_only_enforced if production else None,
        "resultStorage": "verified",
        "schema": settings.trino_schema,
    }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verify Trino query, materialization, ACL, and result storage readiness.")
    parser.add_argument("--allow-disabled", action="store_true")
    arguments = parser.parse_args()
    main(allow_disabled=arguments.allow_disabled)
