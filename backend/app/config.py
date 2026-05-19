from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    app_env: str = "local"
    database_url: str | None = None
    document_storage_dir: str | None = None

    vlm_provider: str = "openai"
    vlm_api_key: str | None = None
    vlm_model_name: str | None = None
    vlm_base_url: str | None = None
    vlm_temperature: float = 0
    vlm_max_retries: int = 2
    vlm_timeout_seconds: int = 120

    openai_api_key: str | None = None
    openai_model_name: str | None = None

    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{BACKEND_DIR / 'kie.db'}"

    @property
    def resolved_storage_dir(self) -> Path:
        raw = self.document_storage_dir or str(BACKEND_DIR / "storage" / "documents")
        path = Path(raw)
        if not path.is_absolute():
            path = BACKEND_DIR / path
        return path

    @property
    def resolved_vlm_api_key(self) -> str | None:
        return self.vlm_api_key or self.openai_api_key

    @property
    def resolved_vlm_model_name(self) -> str | None:
        return self.vlm_model_name or self.openai_model_name


@lru_cache
def get_settings() -> Settings:
    return Settings()
