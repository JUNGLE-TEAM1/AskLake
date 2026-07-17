from uuid import uuid4

from app.core.config import Settings
from app.core.errors import ApiError
from app.services.trino_result_storage import TrinoResultStorage
import app.services.trino_result_storage as result_storage_module


def verify() -> None:
    incomplete_storage = TrinoResultStorage(Settings(
        _env_file=None,
        asklake_object_storage_provider="minio",
        minio_access_key="root-user",
        minio_endpoint="http://127.0.0.1:9000",
        minio_secret_key="root-secret",
        trino_result_storage_access_key="result-user",
        trino_result_storage_secret_key=None,
    ))
    try:
        incomplete_storage._client()
    except ApiError as error:
        assert error.code == "RESULT_STORAGE_UNAVAILABLE"
    else:
        raise AssertionError("Partial dedicated result storage credentials must be rejected")

    runtime_settings = Settings(
        _env_file=None,
        asklake_object_storage_provider="minio",
        minio_access_key="m3admin",
        minio_endpoint="http://127.0.0.1:9000",
        minio_secret_key="wishuponastar",
        trino_result_storage_access_key=None,
        trino_result_storage_auto_create_bucket=True,
        trino_result_storage_bucket="asklake-query-results",
        trino_result_storage_prefix="verify-query-results",
        trino_result_storage_secret_key=None,
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

    captured: dict[str, object] = {}
    original_client = result_storage_module.boto3.client
    try:
        result_storage_module.boto3.client = lambda _service, **kwargs: captured.update(kwargs) or object()
        aws_storage = TrinoResultStorage(Settings(
            _env_file=None,
            asklake_object_storage_provider="aws",
            aws_region="ap-northeast-2",
            s3_endpoint=None,
            s3_force_path_style=False,
            trino_result_storage_access_key=None,
            trino_result_storage_bucket="asklake-query-results",
            trino_result_storage_secret_key=None,
        ))
        aws_storage._ensure_bucket()
        assert aws_storage._bucket_ready is True
    finally:
        result_storage_module.boto3.client = original_client
    assert captured["region_name"] == "ap-northeast-2"
    assert "endpoint_url" not in captured
    assert "aws_access_key_id" not in captured
    assert "aws_secret_access_key" not in captured


if __name__ == "__main__":
    verify()
    print("Trino result storage verification passed.")
