from uuid import uuid4

from app.core.config import Settings
from app.core.errors import ApiError
from app.services.trino_result_storage import TrinoResultStorage


def verify() -> None:
    incomplete_storage = TrinoResultStorage(Settings(
        _env_file=None,
        minio_access_key="root-user",
        minio_endpoint="http://127.0.0.1:9000",
        minio_secret_key="root-secret",
        trino_result_storage_access_key="result-user",
    ))
    try:
        incomplete_storage._client()
    except ApiError as error:
        assert error.code == "RESULT_STORAGE_UNAVAILABLE"
    else:
        raise AssertionError("Partial dedicated result storage credentials must be rejected")

    runtime_settings = Settings(
        _env_file=None,
        minio_access_key="m3admin",
        minio_endpoint="http://127.0.0.1:9000",
        minio_secret_key="wishuponastar",
        trino_result_storage_auto_create_bucket=True,
        trino_result_storage_bucket="asklake-query-results",
        trino_result_storage_prefix="verify-query-results",
    )
    storage = TrinoResultStorage(runtime_settings)
    run_id = f"trino_{uuid4().hex[:12]}"
    stored = storage.write_page(
        run_id=run_id,
        page_index=0,
        columns=["id", "name"],
        rows=[[1, "MinIO result page"], [2, "checksum verified"]],
    )
    try:
        columns, rows = storage.read_page(object_key=stored.object_key, expected_checksum=stored.checksum)
        assert columns == ["id", "name"]
        assert rows == [[1, "MinIO result page"], [2, "checksum verified"]]
        assert stored.compressed_bytes > 0
        assert stored.row_count == 2
    finally:
        storage.delete_object(stored.object_key)


if __name__ == "__main__":
    verify()
    print("Trino result storage verification passed.")
