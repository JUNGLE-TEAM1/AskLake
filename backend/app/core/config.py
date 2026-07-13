import json
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "AskLake FastAPI Backend"
    app_env: str = "local"
    api_prefix: str = "/api"
    database_url: str = "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake"
    local_lake_storage_dir: str | None = None
    openai_api_key: str | None = None
    openai_assistant_enabled: bool = True
    openai_assistant_model: str = "gpt-4o-mini"
    openai_assistant_max_output_tokens: int = Field(default=1200, ge=256, le=4096)
    openai_assistant_max_sample_rows: int = Field(default=5, ge=0, le=20)
    openai_assistant_timeout_seconds: float = Field(default=20.0, ge=1.0, le=60.0)
    openai_query_ai_model: str = "gpt-4.1-mini"
    airflow_api_base_url: str | None = None
    airflow_dag_id: str = "asklake_etl_job"
    airflow_api_token: str | None = None
    airflow_username: str | None = None
    airflow_password: str | None = None
    airflow_request_timeout_seconds: float = 10.0
    airflow_ui_base_url: str | None = None
    continuous_runtime_sync_interval_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    airflow_execution_api_token: str | None = None
    airflow_internal_token: str | None = None
    trino_enabled: bool = False
    trino_base_url: str = "http://localhost:8088"
    trino_catalog: str = "iceberg"
    trino_schema: str = "asklake"
    trino_user: str = "asklake-api"
    trino_auth_username: str | None = None
    trino_auth_password: str | None = None
    trino_materializer_username: str | None = None
    trino_materializer_password: str | None = None
    trino_tls_ca_file: str | None = None
    trino_query_timeout_seconds: float = Field(default=300.0, ge=1.0, le=3600.0)
    trino_max_response_bytes: int = Field(default=2_000_000, ge=65_536, le=50_000_000)
    trino_max_result_bytes: int = Field(default=50_000_000, ge=1_000_000, le=1_000_000_000)
    trino_max_result_pages: int = Field(default=1_000, ge=1, le=100_000)
    trino_result_retention_seconds: int = Field(default=86_400, ge=60, le=604_800)
    trino_max_concurrent_runs_per_user: int = Field(default=2, ge=1, le=100)
    trino_result_storage_bucket: str = "asklake-query-results"
    trino_result_storage_prefix: str = "query-results"
    trino_result_storage_auto_create_bucket: bool = False
    trino_result_storage_access_key: str | None = None
    trino_result_storage_secret_key: str | None = None
    trino_result_cursor_secret: str = "asklake-local-query-result-cursor-secret"
    trino_query_confirmation_secret: str = "asklake-local-query-confirmation-secret"
    trino_query_confirmation_ttl_seconds: int = Field(default=300, ge=30, le=3600)
    trino_query_warning_bytes: int = Field(default=1_073_741_824, ge=0)
    trino_query_max_estimated_bytes: int = Field(default=0, ge=0)
    trino_query_estimated_throughput_bytes_per_second: int = Field(default=268_435_456, ge=1)
    trino_collector_lease_seconds: int = Field(default=60, ge=10, le=3600)
    trino_collector_pages_per_lease: int = Field(default=100, ge=1, le=10_000)
    trino_collector_poll_seconds: float = Field(default=1.0, ge=0.2, le=60.0)
    trino_progress_poll_seconds: float = Field(default=0.5, ge=0.1, le=10.0)
    trino_progress_timeout_seconds: float = Field(default=1.0, ge=0.1, le=10.0)
    trino_cleanup_poll_seconds: float = Field(default=3600.0, ge=60.0, le=86_400.0)
    asklake_object_storage_provider: str = "minio"
    s3_endpoint: str | None = None
    s3_force_path_style: bool = False
    aws_region: str = "ap-northeast-2"
    minio_endpoint: str | None = None
    minio_access_key: str | None = None
    minio_secret_key: str | None = None
    minio_region: str = "us-east-1"
    backend_cors_origins: list[str] = Field(default_factory=lambda: [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ])

    model_config = SettingsConfigDict(
        case_sensitive=False,
        enable_decoding=False,
        env_file=(".env", ".env.local", "backend/.env", "backend/.env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("backend_cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> list[str]:
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                try:
                    parsed = json.loads(text)
                    if isinstance(parsed, list):
                        return [str(origin).strip() for origin in parsed if str(origin).strip()]
                except json.JSONDecodeError:
                    pass
            return [origin.strip() for origin in text.split(",") if origin.strip()]
        if isinstance(value, list):
            return value
        return []

    @field_validator("asklake_object_storage_provider", mode="before")
    @classmethod
    def normalize_object_storage_provider(cls, value: object) -> str:
        normalized = str(value or "minio").strip().lower()
        if normalized in {"aws", "amazon s3", "s3"}:
            return "aws"
        if normalized in {"minio", "minio/s3"}:
            return "minio"
        raise ValueError("ASKLAKE_OBJECT_STORAGE_PROVIDER must be minio or aws")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
