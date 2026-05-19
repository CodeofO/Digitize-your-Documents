from functools import lru_cache
from pathlib import Path
from typing import Mapping

from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
ROOT_ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_LIBREOFFICE_PATH = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
DEFAULT_ENV_VALUES = {
    "APP_ENV": "local",
    "VLM_PROVIDER": "openai",
    "VLM_API_KEY": "",
    "VLM_MODEL_NAME": "",
    "VLM_BASE_URL": "",
    "VLM_TEMPERATURE": "0",
    "VLM_MAX_RETRIES": "2",
    "VLM_TIMEOUT_SECONDS": "120",
    "LIBREOFFICE_PATH": DEFAULT_LIBREOFFICE_PATH,
}


class Settings(BaseSettings):
    app_env: str = "local"
    database_url: str | None = None
    document_storage_dir: str | None = None
    raw_storage_dir: str | None = None
    libreoffice_path: str | None = None

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
        return f"sqlite:///{BACKEND_DIR / 'digitize_documents.db'}"

    @property
    def resolved_storage_dir(self) -> Path:
        raw = self.document_storage_dir or str(BACKEND_DIR / "storage" / "documents")
        path = Path(raw)
        if not path.is_absolute():
            path = BACKEND_DIR / path
        return path

    @property
    def resolved_raw_storage_dir(self) -> Path:
        raw = self.raw_storage_dir or str(BACKEND_DIR / "storage" / "raw")
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


def upsert_root_env(updates: Mapping[str, str], include_defaults: bool = False) -> Path:
    env_path = ROOT_ENV_PATH
    existing_lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    values = {**(DEFAULT_ENV_VALUES if include_defaults or not env_path.exists() else {}), **updates}
    lines = _upsert_env_lines(existing_lines, values)
    env_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    get_settings.cache_clear()
    return env_path


def _upsert_env_lines(lines: list[str], updates: Mapping[str, str]) -> list[str]:
    updated: set[str] = set()
    output: list[str] = []
    for line in lines:
        key = _env_key(line)
        if key and key in updates:
            output.append(f"{key}={_format_env_value(updates[key])}")
            updated.add(key)
        else:
            output.append(line)
    for key, value in updates.items():
        if key not in updated:
            output.append(f"{key}={_format_env_value(value)}")
    return output


def _env_key(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key = stripped.split("=", 1)[0].strip()
    return key or None


def _format_env_value(value: str) -> str:
    if value == "":
        return ""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
