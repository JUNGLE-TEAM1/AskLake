from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


ProviderName = Literal["mock", "openai_compatible"]


class Settings(BaseSettings):
    """Configuration for the isolated AI Gateway service.

    Secrets use ``SecretStr`` so accidental repr/debug output cannot expose them.
    The gateway intentionally has no database, deployment, or MCP configuration.
    """

    app_name: str = "AskLake AI Gateway"
    app_env: str = "local"
    internal_auth_token: SecretStr | None = None

    # Live traffic must use a configured provider. Tests and deterministic local
    # fixtures opt into ``provider="mock"`` explicitly.
    provider: ProviderName = "openai_compatible"
    provider_base_url: str = "https://api.openai.com/v1"
    provider_api_key: SecretStr | None = None
    provider_model: str = "gpt-4.1-mini"
    mcp_enabled: bool = False
    mcp_server_url: str | None = None
    mcp_service_token: SecretStr | None = None
    mcp_timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0)
    context_replay_ttl_seconds: int = Field(default=300, ge=30, le=3600)

    request_timeout_seconds: float = Field(default=30.0, ge=1.0, le=120.0)
    max_request_bytes: int = Field(default=64 * 1024, ge=1024, le=1024 * 1024)
    max_prompt_chars: int = Field(default=8_000, ge=1, le=32_000)
    max_current_query_chars: int = Field(default=20_000, ge=0, le=64_000)
    max_context_bytes: int = Field(default=32 * 1024, ge=0, le=256 * 1024)
    max_context_items: int = Field(default=32, ge=0, le=128)
    max_tool_payloads: int = Field(default=16, ge=0, le=64)
    max_tool_payload_bytes: int = Field(default=32 * 1024, ge=0, le=256 * 1024)
    max_provider_response_bytes: int = Field(
        default=1 * 1024 * 1024,
        ge=16 * 1024,
        le=8 * 1024 * 1024,
    )
    max_output_tokens: int = Field(default=800, ge=64, le=4_096)
    embedding_dimensions: int = Field(default=1536, ge=1, le=8192)
    embedding_batch_size: int = Field(default=64, ge=1, le=256)

    model_config = SettingsConfigDict(
        case_sensitive=False,
        env_file=(".env", ".env.local", "ai-server/.env", "ai-server/.env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("provider_base_url")
    @classmethod
    def validate_provider_base_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("PROVIDER_BASE_URL must be an absolute http(s) URL")
        if parsed.username or parsed.password or parsed.params or parsed.query or parsed.fragment:
            raise ValueError("PROVIDER_BASE_URL must not contain URL credentials")
        return normalized

    @field_validator("provider_model")
    @classmethod
    def validate_provider_model(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or len(normalized) > 200:
            raise ValueError("PROVIDER_MODEL must be between 1 and 200 characters")
        return normalized

    @field_validator("mcp_server_url")
    @classmethod
    def validate_mcp_server_url(cls, value: str | None) -> str | None:
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
            raise ValueError("MCP_SERVER_URL must be an absolute http(s) URL without credentials or query parameters")
        return normalized

    @model_validator(mode="after")
    def require_tls_for_remote_provider(self) -> "Settings":
        local_envs = {"local", "development", "dev", "test", "testing"}
        if (
            self.provider == "openai_compatible"
            and self.app_env.strip().casefold() not in local_envs
            and urlparse(self.provider_base_url).scheme != "https"
        ):
            raise ValueError("PROVIDER_BASE_URL must use https outside local development")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
