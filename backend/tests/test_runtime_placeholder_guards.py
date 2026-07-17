import pytest

from app.core.config import Settings
from app.services.etl_service import configured_spark_output_bucket


def test_backend_configuration_rejects_placeholder_output_bucket() -> None:
    with pytest.raises(ValueError, match="not a placeholder"):
        Settings(asklake_spark_output_bucket="replace-with-asklake-output-bucket")


def test_spark_runtime_rejects_placeholder_output_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASKLAKE_SPARK_OUTPUT_BUCKET", "replace-with-asklake-output-bucket")

    with pytest.raises(ValueError, match="deployment placeholder"):
        configured_spark_output_bucket()


def test_spark_runtime_accepts_real_minio_output_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASKLAKE_SPARK_OUTPUT_BUCKET", "asklake-output")

    assert configured_spark_output_bucket() == "asklake-output"


def test_backend_configuration_rejects_placeholder_query_result_bucket() -> None:
    with pytest.raises(ValueError, match="not a placeholder"):
        Settings(trino_result_storage_bucket="replace-with-asklake-query-results-bucket")


def test_local_http_trino_rejects_basic_auth_credentials() -> None:
    with pytest.raises(ValueError, match="requires an https"):
        Settings(
            trino_enabled=True,
            trino_base_url="http://trino:8080",
            trino_auth_username="asklake-api",
            trino_auth_password="password",
        )
