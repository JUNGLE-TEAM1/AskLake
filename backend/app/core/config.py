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
    backend_cors_origins: list[str] = Field(default_factory=lambda: [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ])

    model_config = SettingsConfigDict(
        case_sensitive=False,
        env_file=".env",
        env_file_encoding="utf-8",
    )

    @field_validator("backend_cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> list[str]:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        if isinstance(value, list):
            return value
        return []


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
