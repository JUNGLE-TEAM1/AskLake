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
    airflow_execution_api_token: str | None = None
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
