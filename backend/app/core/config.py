import json
import re
from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "AskLake FastAPI Backend"
    app_env: str = "local"
    api_prefix: str = "/api"
    database_url: str = "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake"
    database_connect_timeout_seconds: int = Field(default=5, ge=1, le=30)
    local_lake_storage_dir: str | None = None
    openai_api_key: str | None = None
    openai_assistant_enabled: bool = True
    openai_assistant_model: str = "gpt-4o-mini"
    openai_assistant_max_output_tokens: int = Field(default=1200, ge=256, le=4096)
    openai_assistant_max_sample_rows: int = Field(default=5, ge=0, le=20)
    openai_assistant_timeout_seconds: float = Field(default=20.0, ge=1.0, le=60.0)
    openai_query_ai_model: str = "gpt-4.1-mini"
    ai_query_provider: Literal["direct", "gateway"] = "direct"
    ai_gateway_base_url: str | None = None
    ai_gateway_generate_path: str = "/v1/generate"
    ai_gateway_service_token: str | None = None
    ai_gateway_timeout_seconds: float = Field(default=30.0, ge=1.0, le=120.0)
    ai_gateway_max_response_bytes: int = Field(default=1_048_576, ge=65_536, le=16_777_216)
    ai_gateway_max_embedding_response_bytes: int = Field(default=8_388_608, ge=65_536, le=134_217_728)
    ai_gateway_classification_path: str = "/v1/generate"
    ai_gateway_embeddings_path: str = "/v1/embeddings"
    ai_mcp_path: str = "/internal/mcp"
    ai_mcp_service_token: str | None = None
    ai_context_signing_secret: str = "asklake-local-ai-context-signing-secret"
    ai_context_ttl_seconds: int = Field(default=300, ge=30, le=3600)
    ai_context_max_sample_rows: int = Field(default=20, ge=0, le=20)
    semantic_model_default_version: int = Field(default=1, ge=1)
    rag_classification_sample_rows: int = Field(default=20, ge=1, le=100)
    rag_document_preview_limit: int = Field(default=20, ge=1, le=100)
    rag_embedding_model: str = "text-embedding-3-small"
    rag_embedding_dimensions: int = Field(default=1536, ge=1, le=8192)
    rag_embedding_batch_size: int = Field(default=64, ge=1, le=256)
    rag_chunk_target_tokens: int = Field(default=800, ge=100, le=2_000)
    rag_chunk_overlap_tokens: int = Field(default=400, ge=0, le=1_000)
    rag_chunk_max_tokens: int = Field(default=1_200, ge=100, le=4_000)
    rag_context_max_tokens: int = Field(default=6_000, ge=256, le=32_000)
    rag_query_intelligence_enabled: bool = True
    rag_relevance_min_score: float = Field(default=0.6, ge=0.0, le=1.0)
    rag_failed_row_rate_threshold: float = Field(default=0.05, ge=0.0, le=1.0)
    rag_artifact_retention_days: int = Field(default=30, ge=1, le=3_650)
    rag_artifact_keep_previous_indexes: int = Field(default=1, ge=0, le=100)
    rag_runtime_create_schema: bool = False
    rag_staging_base_path: str = "s3a://asklake-warehouse/rag-staging"
    rag_parent_iceberg_namespace: str = "rag"
    rag_index_prefix: str = "asklake-rag"
    opensearch_base_url: str | None = None
    opensearch_username: str | None = None
    opensearch_password: str | None = None
    opensearch_timeout_seconds: float = Field(default=30.0, ge=1.0, le=120.0)
    opensearch_verify_tls: bool = True
    opensearch_ca_cert: str | None = None
    airflow_api_base_url: str | None = None
    airflow_dag_id: str = "asklake_etl_job"
    rag_airflow_dag_id: str = "asklake_rag_index"
    airflow_api_token: str | None = None
    airflow_username: str | None = None
    airflow_password: str | None = None
    airflow_request_timeout_seconds: float = 10.0
    airflow_run_sync_interval_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    rag_worker_base_url: str | None = None
    rag_worker_token: str | None = None
    airflow_ui_base_url: str | None = None
    continuous_runtime_sync_interval_seconds: float = Field(default=1.0, ge=1.0, le=60.0)
    dashboard_sync_mode: str = "polling"
    realtime_events_enabled: bool = False
    continuous_sql_join_enabled: bool = False
    latest_static_per_batch_enabled: bool = False
    static_change_backfill_enabled: bool = False
    continuous_sql_static_broadcast_max_rows: int = Field(default=100_000, ge=0, le=100_000_000)
    continuous_sql_static_cache_max_rows: int = Field(default=5_000_000, ge=0, le=1_000_000_000)
    continuous_sql_max_output_rows_per_input: int = Field(default=10, ge=1, le=10_000)
    clickhouse_continuous_join_enabled: bool = False
    clickhouse_url: str = "http://localhost:8123"
    clickhouse_user: str = "asklake"
    clickhouse_password: str | None = None
    clickhouse_database: str = "asklake"
    clickhouse_query_timeout_seconds: float = Field(default=60.0, ge=1.0, le=300.0)
    clickhouse_static_load_max_rows: int = Field(default=15_000_000, ge=1, le=100_000_000)
    clickhouse_insert_batch_rows: int = Field(default=20_000, ge=1, le=100_000)
    realtime_event_retention_seconds: int = Field(default=86_400, ge=60, le=604_800)
    realtime_event_payload_max_bytes: int = Field(default=8_192, ge=512, le=65_536)
    realtime_replay_limit: int = Field(default=500, ge=1, le=5_000)
    realtime_subscriber_queue_size: int = Field(default=128, ge=8, le=1_000)
    realtime_connection_limit_per_actor: int = Field(default=5, ge=1, le=50)
    realtime_heartbeat_seconds: int = Field(default=15, ge=5, le=60)
    realtime_dispatch_poll_seconds: float = Field(default=0.5, ge=0.1, le=10.0)
    realtime_cleanup_interval_seconds: int = Field(default=3_600, ge=60, le=86_400)
    realtime_sse_send_timeout_seconds: int = Field(default=10, ge=1, le=60)
    scheduled_job_tick_interval_seconds: float = Field(default=30.0, ge=5.0, le=300.0)
    airflow_execution_api_token: str | None = None
    airflow_internal_token: str | None = None
    asklake_object_storage_provider: str = "minio"
    asklake_spark_output_bucket: str = "asklake-output"
    s3_endpoint: str | None = None
    s3_force_path_style: bool = False
    aws_region: str = "ap-northeast-2"
    asklake_spark_iceberg_catalog_name: str = "asklake"
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
    trino_max_response_bytes: int = Field(default=20_000_000, ge=65_536, le=50_000_000)
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
    minio_endpoint: str | None = None
    minio_access_key: str | None = None
    minio_secret_key: str | None = None
    minio_region: str = "us-east-1"
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None
    bootstrap_admin_display_name: str = "AskLake Administrator"
    auth_legacy_demo_users_enabled: bool = False
    auth_public_signup_enabled: bool = False
    auth_session_cookie_secure: bool | None = None
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
                        return [str(origin).strip().rstrip("/") for origin in parsed if str(origin).strip()]
                except json.JSONDecodeError:
                    pass
            return [origin.strip().rstrip("/") for origin in text.split(",") if origin.strip()]
        if isinstance(value, list):
            return [str(origin).strip().rstrip("/") for origin in value if str(origin).strip()]
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

    @field_validator("asklake_spark_output_bucket", mode="before")
    @classmethod
    def validate_spark_output_bucket(cls, value: object) -> str:
        normalized = str(value or "asklake-output").strip()
        if (
            "replace-with-" in normalized.casefold()
            or not 3 <= len(normalized) <= 63
            or re.fullmatch(r"[a-z0-9][a-z0-9.-]*[a-z0-9]", normalized) is None
            or ".." in normalized
        ):
            raise ValueError("ASKLAKE_SPARK_OUTPUT_BUCKET must be a real S3/MinIO bucket name, not a placeholder")
        return normalized

    @field_validator("trino_result_storage_bucket", mode="before")
    @classmethod
    def validate_trino_result_storage_bucket(cls, value: object) -> str:
        normalized = str(value or "asklake-query-results").strip()
        if (
            "replace-with-" in normalized.casefold()
            or not 3 <= len(normalized) <= 63
            or re.fullmatch(r"[a-z0-9][a-z0-9.-]*[a-z0-9]", normalized) is None
            or ".." in normalized
        ):
            raise ValueError("TRINO_RESULT_STORAGE_BUCKET must be a real S3/MinIO bucket name, not a placeholder")
        return normalized

    @field_validator("ai_gateway_base_url")
    @classmethod
    def validate_ai_gateway_base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().rstrip("/")
        parsed = urlparse(normalized)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("AI_GATEWAY_BASE_URL must be an absolute http(s) URL without credentials or query parameters")
        return normalized

    @field_validator(
        "ai_gateway_generate_path",
        "ai_gateway_classification_path",
        "ai_gateway_embeddings_path",
        "ai_mcp_path",
    )
    @classmethod
    def validate_ai_internal_path(cls, value: str) -> str:
        normalized = value.strip()
        parsed = urlparse(normalized)
        if (
            not normalized.startswith("/")
            or normalized.startswith("//")
            or not parsed.path
            or normalized == "/"
            or parsed.path != normalized
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("AI internal paths must be absolute paths without query parameters")
        return normalized.rstrip("/") or "/"

    @model_validator(mode="after")
    def validate_bootstrap_admin(self) -> "Settings":
        if self.auth_legacy_demo_users_enabled and not self.is_test_runtime:
            raise ValueError("AUTH_LEGACY_DEMO_USERS_ENABLED is restricted to test environments")
        if bool(self.bootstrap_admin_email) != bool(self.bootstrap_admin_password):
            raise ValueError(
                "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be configured together"
            )
        if not self.is_development_runtime and not self.bootstrap_admin_email:
            raise ValueError(
                "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required outside local/dev/test"
            )
        if self.bootstrap_admin_email:
            normalized_email = str(self.bootstrap_admin_email or "").strip().casefold()
            local_part, separator, domain = normalized_email.partition("@")
            if not separator or not local_part or "." not in domain or domain.startswith(".") or domain.endswith("."):
                raise ValueError("BOOTSTRAP_ADMIN_EMAIL must be a valid administrator email address")
            if len(str(self.bootstrap_admin_password or "")) < 16:
                raise ValueError("BOOTSTRAP_ADMIN_PASSWORD must contain at least 16 characters")
        placeholder_values = {
            "replace-with-admin-email@example.invalid",
            "replace-with-a-unique-bootstrap-password",
            "admin.user@asklake.local",
            "demo.user@asklake.local",
            "asklake-admin",
            "asklake-demo",
        }
        if self.bootstrap_admin_email and (
            str(self.bootstrap_admin_email or "").casefold() in placeholder_values
            or self.bootstrap_admin_password in placeholder_values
        ):
            raise ValueError("Replace the bootstrap administrator placeholders before startup")
        if not self.is_development_runtime:
            for origin in self.backend_cors_origins:
                parsed = urlparse(origin)
                if (
                    origin == "*"
                    or parsed.scheme != "https"
                    or not parsed.netloc
                    or parsed.username is not None
                    or parsed.password is not None
                    or parsed.path not in {"", "/"}
                    or parsed.params
                    or parsed.query
                    or parsed.fragment
                ):
                    raise ValueError(
                        "BACKEND_CORS_ORIGINS must contain only explicit https origins outside local development"
                    )
        if self.trino_enabled:
            parsed_trino_url = urlparse(self.trino_base_url)
            for username_key, username, password_key, password in (
                (
                    "TRINO_AUTH_USERNAME",
                    self.trino_auth_username,
                    "TRINO_AUTH_PASSWORD",
                    self.trino_auth_password,
                ),
                (
                    "TRINO_MATERIALIZER_USERNAME",
                    self.trino_materializer_username,
                    "TRINO_MATERIALIZER_PASSWORD",
                    self.trino_materializer_password,
                ),
            ):
                if bool(str(username or "").strip()) != bool(str(password or "").strip()):
                    raise ValueError(f"{username_key} and {password_key} must be configured together")
            if parsed_trino_url.scheme == "http" and (
                self.trino_auth_password or self.trino_materializer_password
            ):
                raise ValueError("Trino Basic authentication requires an https TRINO_BASE_URL")

        if not self.is_development_runtime and self.trino_enabled:
            if parsed_trino_url.scheme != "https" or not parsed_trino_url.netloc:
                raise ValueError("TRINO_BASE_URL must be an explicit https URL when Trino is enabled")

            required_trino_values = {
                "TRINO_AUTH_USERNAME": self.trino_auth_username,
                "TRINO_AUTH_PASSWORD": self.trino_auth_password,
                "TRINO_MATERIALIZER_USERNAME": self.trino_materializer_username,
                "TRINO_MATERIALIZER_PASSWORD": self.trino_materializer_password,
                "TRINO_TLS_CA_FILE": self.trino_tls_ca_file,
                "TRINO_RESULT_STORAGE_BUCKET": self.trino_result_storage_bucket,
                "TRINO_RESULT_CURSOR_SECRET": self.trino_result_cursor_secret,
                "TRINO_QUERY_CONFIRMATION_SECRET": self.trino_query_confirmation_secret,
            }
            for key, value in required_trino_values.items():
                normalized = str(value or "").strip()
                if not normalized or "replace-with-" in normalized or "asklake-local-" in normalized:
                    raise ValueError(f"{key} must be a non-placeholder production value when Trino is enabled")

            if self.trino_auth_username == self.trino_materializer_username:
                raise ValueError("TRINO_AUTH_USERNAME and TRINO_MATERIALIZER_USERNAME must be distinct")
            if self.trino_auth_password == self.trino_materializer_password:
                raise ValueError("TRINO_AUTH_PASSWORD and TRINO_MATERIALIZER_PASSWORD must be distinct")
            for key, secret in {
                "TRINO_AUTH_PASSWORD": self.trino_auth_password,
                "TRINO_MATERIALIZER_PASSWORD": self.trino_materializer_password,
            }.items():
                if len(str(secret or "")) < 16:
                    raise ValueError(f"{key} must contain at least 16 characters")
            for key, secret in {
                "TRINO_RESULT_CURSOR_SECRET": self.trino_result_cursor_secret,
                "TRINO_QUERY_CONFIRMATION_SECRET": self.trino_query_confirmation_secret,
            }.items():
                if len(str(secret or "")) < 32:
                    raise ValueError(f"{key} must contain at least 32 characters")
        if not self.allows_header_auth_fallback and self.clickhouse_continuous_join_enabled:
            if not self.trino_enabled:
                raise ValueError(
                    "TRINO_ENABLED must be true when CLICKHOUSE_CONTINUOUS_JOIN_ENABLED is true"
                )
            parsed_clickhouse_url = urlparse(self.clickhouse_url)
            if parsed_clickhouse_url.scheme not in {"http", "https"} or not parsed_clickhouse_url.netloc:
                raise ValueError("CLICKHOUSE_URL must be an explicit http(s) URL")
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", self.clickhouse_database) is None:
                raise ValueError("CLICKHOUSE_DATABASE must be a safe ClickHouse identifier")
            if not self.clickhouse_user.strip():
                raise ValueError("CLICKHOUSE_USER is required")
            password = str(self.clickhouse_password or "")
            if len(password) < 16 or "replace-with-" in password:
                raise ValueError(
                    "CLICKHOUSE_PASSWORD must be a non-placeholder value with at least 16 characters"
                )
        if (
            not self.is_development_runtime
            and self.ai_query_provider == "gateway"
        ):
            required_ai_values = {
                "AI_GATEWAY_BASE_URL": self.ai_gateway_base_url,
                "AI_GATEWAY_SERVICE_TOKEN": self.ai_gateway_service_token,
                "AI_MCP_SERVICE_TOKEN": self.ai_mcp_service_token,
                "AI_CONTEXT_SIGNING_SECRET": self.ai_context_signing_secret,
            }
            for key, value in required_ai_values.items():
                normalized = str(value or "").strip()
                if not normalized or "replace-with-" in normalized or "asklake-local-" in normalized:
                    raise ValueError(f"{key} must be a non-placeholder production value when AI gateway is enabled")
            if len(self.ai_context_signing_secret) < 32:
                raise ValueError("AI_CONTEXT_SIGNING_SECRET must contain at least 32 characters")
        minimum_embedding_response_budget = self.rag_embedding_batch_size * self.rag_embedding_dimensions * 32 + 16_384
        if self.ai_gateway_max_embedding_response_bytes < minimum_embedding_response_budget:
            raise ValueError("AI_GATEWAY_MAX_EMBEDDING_RESPONSE_BYTES is too small for the configured RAG embedding batch contract")
        return self

    @property
    def is_development_runtime(self) -> bool:
        return self.app_env.strip().casefold() in {"local", "development", "dev", "test", "testing"}

    @property
    def is_test_runtime(self) -> bool:
        return self.app_env.strip().casefold() in {"test", "testing"}

    @property
    def allows_header_auth_fallback(self) -> bool:
        return self.is_test_runtime

    @property
    def uses_secure_session_cookie(self) -> bool:
        if self.auth_session_cookie_secure is not None:
            return self.auth_session_cookie_secure
        return not self.allows_header_auth_fallback

    @property
    def allows_public_signup(self) -> bool:
        return self.is_development_runtime or self.auth_public_signup_enabled


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
