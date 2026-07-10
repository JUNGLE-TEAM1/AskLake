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
    text_structuring_enabled: bool = True
    text_structuring_api_url: str = "https://api.openai.com/v1"
    text_structuring_api_key: str | None = None
    text_structuring_model: str = "gpt-4.1-mini"
    text_structuring_max_output_tokens: int = Field(default=8192, ge=512, le=32768)
    text_structuring_timeout_seconds: float = Field(default=60.0, ge=1.0, le=300.0)
    text_structuring_preview_max_rows: int = Field(default=100, ge=1, le=1000)
    text_structuring_batch_max_rows: int = Field(default=512, ge=1, le=5000)
    text_structuring_batch_size: int = Field(default=32, ge=1, le=512)
    text_structuring_review_sample_rate: float = Field(default=0.01, ge=0, le=1)
    text_structuring_review_max_per_batch: int = Field(default=10, ge=0, le=512)
    text_structuring_external_provider_allowed: bool = False
    text_structuring_internal_token: str | None = None
    text_structuring_model_dir: str = "backend/tmp/text-structuring-models"
    airflow_api_base_url: str | None = None
    airflow_dag_id: str = "asklake_etl_job"
    airflow_api_token: str | None = None
    airflow_username: str | None = None
    airflow_password: str | None = None
    airflow_request_timeout_seconds: float = 10.0
    airflow_ui_base_url: str | None = None
    airflow_callback_token: str | None = None
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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
