import json
from functools import lru_cache
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator
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
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None
    bootstrap_admin_display_name: str = "AskLake Administrator"
    auth_public_signup_enabled: bool = False
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

    @model_validator(mode="after")
    def validate_bootstrap_admin(self) -> "Settings":
        if bool(self.bootstrap_admin_email) != bool(self.bootstrap_admin_password):
            raise ValueError(
                "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be configured together"
            )
        if not self.allows_header_auth_fallback and not self.bootstrap_admin_email:
            raise ValueError(
                "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required outside local/dev/test"
            )
        placeholder_values = {
            "replace-with-admin-email@example.invalid",
            "replace-with-a-unique-bootstrap-password",
            "admin.user@asklake.local",
            "demo.user@asklake.local",
            "asklake-admin",
            "asklake-demo",
        }
        if not self.allows_header_auth_fallback and (
            self.bootstrap_admin_email in placeholder_values
            or self.bootstrap_admin_password in placeholder_values
        ):
            raise ValueError("Replace the production bootstrap administrator placeholders before startup")
        if not self.allows_header_auth_fallback:
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
        return self

    @property
    def allows_header_auth_fallback(self) -> bool:
        return self.app_env.strip().casefold() in {"local", "development", "dev", "test", "testing"}

    @property
    def allows_public_signup(self) -> bool:
        return self.allows_header_auth_fallback or self.auth_public_signup_enabled


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
