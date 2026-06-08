from functools import lru_cache
from pathlib import Path
from typing import Mapping

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.vlm_params import VlmInferenceParams, default_vlm_inference_params_json


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
ROOT_ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_LIBREOFFICE_PATH = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
DEFAULT_CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]
DEFAULT_CORS_ALLOW_ORIGIN_REGEX = r"^http://(localhost|127\.0\.0\.1):\d+$"
DEFAULT_ENV_VALUES = {
    "APP_ENV": "local",
    "CORS_ALLOWED_ORIGINS": "",
    "CORS_ALLOW_ORIGIN_REGEX": "",
    "ALLOW_RUNTIME_SETTINGS": "false",
    "SERVE_FRONTEND": "false",
    "FRONTEND_DIST_DIR": "",
    "STORAGE_BACKEND": "local",
    "OBJECT_STORAGE_ENDPOINT_URL": "",
    "OBJECT_STORAGE_REGION": "",
    "OBJECT_STORAGE_BUCKET": "",
    "OBJECT_STORAGE_ACCESS_KEY_ID": "",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY": "",
    "OBJECT_STORAGE_FORCE_PATH_STYLE": "false",
    "OBJECT_STORAGE_PREFIX": "",
    "UPLOAD_MAX_FILE_BYTES": "52428800",
    "UPLOAD_MAX_BATCH_FILES": "10000",
    "UPLOAD_CHUNK_FILES": "10",
    "UPLOAD_MAX_PDF_PAGES": "30",
    "UPLOAD_MAX_IMAGE_PIXELS": "50000000",
    "PREPROCESS_MAX_WORKERS": "2",
    "DOCUMENT_PAGE_MAX_LONG_EDGE": "3000",
    "DOCUMENT_PAGE_JPEG_QUALITY": "88",
    "PROCESSING_TMP_DIR": "",
    "UPLOAD_RETENTION_HOURS": "",
    "RETENTION_CLEANUP_INTERVAL_SECONDS": "86400",
    "SECURITY_HEADERS_ENABLED": "true",
    "VLM_PROVIDER": "auto",
    "VLM_API_KEY": "",
    "VLM_MODEL_NAME": "",
    "VLM_BASE_URL": "",
    "VLM_MAX_RETRIES": "2",
    "VLM_TIMEOUT_SECONDS": "120",
    "VLM_INFERENCE_PARAMS": default_vlm_inference_params_json(),
    "WORKFLOW_MAX_WORKERS": "16",
    "VLM_MAX_CONCURRENT_REQUESTS": "128",
    "KIE_FIELD_GROUP_SIZE": "2",
    "LIBREOFFICE_PATH": DEFAULT_LIBREOFFICE_PATH,
}


class Settings(BaseSettings):
    app_env: str = "local"
    database_url: str | None = None
    document_storage_dir: str | None = None
    raw_storage_dir: str | None = None
    libreoffice_path: str | None = None
    cors_allowed_origins: str | None = None
    cors_allow_origin_regex: str | None = None
    database_pool_size: int = 64
    database_max_overflow: int = 0
    database_pool_timeout_seconds: int = 60
    allow_runtime_settings: bool = False
    serve_frontend: bool = False
    frontend_dist_dir: str | None = None
    storage_backend: str = "local"
    object_storage_endpoint_url: str | None = None
    object_storage_region: str | None = None
    object_storage_bucket: str | None = None
    object_storage_access_key_id: str | None = None
    object_storage_secret_access_key: str | None = None
    object_storage_force_path_style: bool = False
    object_storage_prefix: str | None = None
    upload_max_file_bytes: int = 50 * 1024 * 1024
    upload_max_batch_files: int = 10000
    upload_chunk_files: int = 10
    upload_max_pdf_pages: int = 30
    upload_max_image_pixels: int = 50_000_000
    preprocess_max_workers: int = 2
    document_page_max_long_edge: int = 3000
    document_page_jpeg_quality: int = 88
    processing_tmp_dir: str | None = None
    upload_retention_hours: int | None = None
    retention_cleanup_interval_seconds: int = 86400
    security_headers_enabled: bool = True

    vlm_provider: str = "auto"
    vlm_api_key: str | None = None
    vlm_model_name: str | None = None
    vlm_base_url: str | None = None
    vlm_temperature: float = 0
    vlm_max_retries: int = 2
    vlm_timeout_seconds: int = 120
    vlm_inference_params: str | None = None
    vlm_reasoning_effort: str | None = None
    vlm_verbosity: str | None = None
    vlm_max_completion_tokens: str | None = None
    vlm_top_p: str | None = None
    vlm_service_tier: str | None = None
    workflow_max_workers: int = 16
    vlm_max_concurrent_requests: int = 128
    kie_field_group_size: int = 2

    openai_api_key: str | None = None
    openai_model_name: str | None = None

    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("upload_retention_hours", mode="before")
    @classmethod
    def blank_optional_int_to_none(cls, value):
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return _normalize_sqlite_url(self.database_url)
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
    def resolved_processing_tmp_dir(self) -> Path:
        raw = self.processing_tmp_dir or str(BACKEND_DIR / "storage" / "processing")
        path = Path(raw)
        if not path.is_absolute():
            path = BACKEND_DIR / path
        return path

    @property
    def resolved_frontend_dist_dir(self) -> Path:
        raw = self.frontend_dist_dir or str(PROJECT_ROOT / "frontend" / "dist")
        path = Path(raw)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        return path

    @property
    def is_production(self) -> bool:
        return self.app_env.strip().lower() in {"prod", "production"}

    @property
    def runtime_settings_writable(self) -> bool:
        return not self.is_production or self.allow_runtime_settings

    @property
    def resolved_upload_retention_hours(self) -> int:
        if self.upload_retention_hours is not None:
            return max(0, self.upload_retention_hours)
        return 24 if self.is_production else 0

    @property
    def resolved_vlm_api_key(self) -> str | None:
        return self.vlm_api_key or self.openai_api_key

    @property
    def resolved_vlm_model_name(self) -> str | None:
        return self.vlm_model_name or self.openai_model_name

    @property
    def resolved_vlm_inference_params(self) -> dict[str, str]:
        return VlmInferenceParams.from_raw_env(
            self.vlm_inference_params,
            legacy_values={
                "reasoning_effort": self.vlm_reasoning_effort,
                "verbosity": self.vlm_verbosity,
                "max_completion_tokens": self.vlm_max_completion_tokens,
                "top_p": self.vlm_top_p,
                "service_tier": self.vlm_service_tier,
            },
            legacy_temperature=self.vlm_temperature,
        ).as_dict()


@lru_cache
def get_settings() -> Settings:
    return Settings()


def parse_cors_allowed_origins(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return DEFAULT_CORS_ALLOWED_ORIGINS
    return [origin.strip() for origin in raw.replace("\n", ",").split(",") if origin.strip()]


def resolved_cors_allow_origin_regex(raw: str | None) -> str | None:
    if raw is None:
        return DEFAULT_CORS_ALLOW_ORIGIN_REGEX
    stripped = raw.strip()
    return stripped or DEFAULT_CORS_ALLOW_ORIGIN_REGEX


def upsert_root_env(updates: Mapping[str, str], include_defaults: bool = False, remove_keys: set[str] | None = None) -> Path:
    env_path = ROOT_ENV_PATH
    existing_lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    if remove_keys:
        existing_lines = [line for line in existing_lines if _env_key(line) not in remove_keys]
    if include_defaults:
        existing_keys = {_env_key(line) for line in existing_lines}
        defaults = {key: value for key, value in DEFAULT_ENV_VALUES.items() if key not in existing_keys}
    else:
        defaults = DEFAULT_ENV_VALUES if not env_path.exists() else {}
    values = {**defaults, **updates}
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


def _normalize_sqlite_url(url: str) -> str:
    if url == "sqlite:///:memory:" or not url.startswith("sqlite:///") or url.startswith("sqlite:////"):
        return url
    raw_path = url.removeprefix("sqlite:///")
    path = Path(raw_path)
    if path.is_absolute():
        return url
    return f"sqlite:///{PROJECT_ROOT / path}"
