from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


ProviderName = Literal["mock", "openai_compatible"]


class Settings(BaseSettings):
    """Configuration for the isolated AI Gateway service.

    Secrets use ``SecretStr`` so accidental repr/debug output cannot expose them.
    The gateway owns provider routing and a bounded read-only MCP catalog client,
    but intentionally has no product database or SQL execution capability.
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
    provider_model_query_sql: str | None = None
    provider_model_dashboard_assistant: str | None = None
    provider_model_etl_transform: str | None = None
    provider_model_rag: str | None = None
    provider_model_review: str | None = None
    provider_fallback_base_url: str | None = None
    provider_fallback_api_key: SecretStr | None = None
    provider_fallback_model: str | None = None
    provider_max_attempts: int = Field(default=3, ge=1, le=5)
    provider_retry_base_seconds: float = Field(default=0.25, ge=0, le=10)
    provider_input_cost_per_million_tokens: float = Field(default=0, ge=0)
    provider_output_cost_per_million_tokens: float = Field(default=0, ge=0)
    provider_healthcheck_enabled: bool = True
    provider_healthcheck_path: str = "/models"
    mcp_enabled: bool = False
    mcp_server_url: str | None = None
    mcp_service_token: SecretStr | None = None
    mcp_timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0)
    context_replay_ttl_seconds: int = Field(default=300, ge=30, le=3600)
    context_replay_max_entries: int = Field(default=10_000, ge=100, le=1_000_000)

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
    max_embedding_provider_response_bytes: int = Field(
        default=8 * 1024 * 1024,
        ge=64 * 1024,
        le=128 * 1024 * 1024,
    )
    max_output_tokens: int = Field(default=1800, ge=64, le=4_096)
    embedding_dimensions: int = Field(default=1536, ge=1, le=8192)
    embedding_batch_size: int = Field(default=64, ge=1, le=256)

    model_config = SettingsConfigDict(
        case_sensitive=False,
        env_file=(".env", ".env.local", "ai-server/.env", "ai-server/.env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator(
        "provider_model_query_sql",
        "provider_model_dashboard_assistant",
        "provider_model_etl_transform",
        "provider_model_rag",
        "provider_model_review",
        "provider_fallback_base_url",
        "provider_fallback_api_key",
        "provider_fallback_model",
        "mcp_server_url",
        mode="before",
    )
    @classmethod
    def normalize_blank_optional_values(cls, value: object) -> object | None:
        """Treat blank Compose values as an omitted optional setting.

        Compose intentionally emits empty strings for optional provider fallback
        fields.  Rejecting those values makes the gateway impossible to start
        unless a fallback provider is configured.
        """

        raw_value = value.get_secret_value() if isinstance(value, SecretStr) else value
        if isinstance(raw_value, str) and not raw_value.strip():
            return None
        return value

    @field_validator("provider_base_url", "provider_fallback_base_url")
    @classmethod
    def validate_provider_base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().rstrip("/")
        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("PROVIDER_BASE_URL must be an absolute http(s) URL")
        if parsed.username or parsed.password or parsed.params or parsed.query or parsed.fragment:
            raise ValueError("PROVIDER_BASE_URL must not contain URL credentials")
        return normalized

    @field_validator(
        "provider_model",
        "provider_model_query_sql",
        "provider_model_dashboard_assistant",
        "provider_model_etl_transform",
        "provider_model_rag",
        "provider_model_review",
        "provider_fallback_model",
    )
    @classmethod
    def validate_provider_model(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or len(normalized) > 200:
            raise ValueError("PROVIDER_MODEL must be between 1 and 200 characters")
        return normalized

    @field_validator("provider_healthcheck_path")
    @classmethod
    def validate_provider_healthcheck_path(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized.startswith("/") or "?" in normalized or "#" in normalized:
            raise ValueError("PROVIDER_HEALTHCHECK_PATH must be an absolute URL path without query parameters")
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
        normalized_env = self.app_env.strip().casefold()
        if self.provider == "mock" and normalized_env not in {"test", "testing"}:
            raise ValueError("PROVIDER=mock is restricted to test environments")
        local_envs = {"local", "development", "dev", "test", "testing"}
        if (
            self.provider == "openai_compatible"
            and normalized_env not in local_envs
            and urlparse(self.provider_base_url).scheme != "https"
        ):
            raise ValueError("PROVIDER_BASE_URL must use https outside local development")
        if self.provider_fallback_base_url and not self.provider_fallback_api_key:
            raise ValueError("PROVIDER_FALLBACK_API_KEY is required when PROVIDER_FALLBACK_BASE_URL is configured")
        if (
            self.provider_fallback_base_url
            and normalized_env not in local_envs
            and urlparse(self.provider_fallback_base_url).scheme != "https"
        ):
            raise ValueError("PROVIDER_FALLBACK_BASE_URL must use https outside local development")
        minimum_embedding_response_budget = (
            self.embedding_batch_size * self.embedding_dimensions * 32
            + 16 * 1024
        )
        if self.max_embedding_provider_response_bytes < minimum_embedding_response_budget:
            raise ValueError(
                "MAX_EMBEDDING_PROVIDER_RESPONSE_BYTES is too small for the configured embedding batch and dimensions"
            )
        return self

    def model_for_mode(self, mode: str) -> str:
        if mode == "query_sql":
            return self.provider_model_query_sql or self.provider_model
        if mode == "dashboard_assistant":
            return self.provider_model_dashboard_assistant or self.provider_model
        if mode == "etl_transform":
            return self.provider_model_etl_transform or self.provider_model
        if mode in {"classify_dataset", "segment_document", "rag_query_plan", "rag_relevance"}:
            return self.provider_model_rag or self.provider_model
        if mode in {"review_schema", "review_row"}:
            return self.provider_model_review or self.provider_model
        return self.provider_model


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
