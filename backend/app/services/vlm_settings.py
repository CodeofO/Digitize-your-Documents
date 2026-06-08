import os
from typing import Any

from fastapi import HTTPException

from app.config import DEFAULT_LIBREOFFICE_PATH, ROOT_ENV_PATH, get_settings, upsert_root_env
from app.schemas import SystemStatusRead, VlmSettingsRead, VlmSettingsUpdate
from app.vlm import resolve_vlm_api_style
from app.vlm_params import VlmInferenceParams, normalize_vlm_inference_params


class VlmSettingsService:
    def read_system_status(self) -> SystemStatusRead:
        settings = get_settings()
        provider = resolve_vlm_api_style(settings)
        return SystemStatusRead(
            app_env=settings.app_env,
            vlm_provider=provider,
            vlm_model_name=settings.resolved_vlm_model_name,
            has_vlm_credentials=bool(settings.resolved_vlm_api_key and settings.resolved_vlm_model_name),
            is_mock=provider == "mock",
            upload_max_batch_files=settings.upload_max_batch_files,
            upload_chunk_files=settings.upload_chunk_files,
            preprocess_max_workers=settings.preprocess_max_workers,
            workflow_max_workers=settings.workflow_max_workers,
            vlm_max_concurrent_requests=settings.vlm_max_concurrent_requests,
            document_page_max_long_edge=settings.document_page_max_long_edge,
            document_page_jpeg_quality=settings.document_page_jpeg_quality,
        )

    def read_vlm_settings(self) -> VlmSettingsRead:
        settings = get_settings()
        inference_params = settings.resolved_vlm_inference_params
        return VlmSettingsRead(
            provider=resolve_vlm_api_style(settings),
            model_name=settings.resolved_vlm_model_name,
            base_url=settings.vlm_base_url,
            libreoffice_path=settings.libreoffice_path or DEFAULT_LIBREOFFICE_PATH,
            inference_params=inference_params,
            reasoning_effort=inference_params.get("reasoning_effort"),
            verbosity=inference_params.get("verbosity"),
            temperature=inference_params.get("temperature"),
            max_completion_tokens=inference_params.get("max_completion_tokens"),
            top_p=inference_params.get("top_p"),
            service_tier=inference_params.get("service_tier"),
            workflow_max_workers=settings.workflow_max_workers,
            vlm_max_concurrent_requests=settings.vlm_max_concurrent_requests,
            vlm_timeout_seconds=settings.vlm_timeout_seconds,
            kie_field_group_size=settings.kie_field_group_size,
            has_api_key=bool(settings.resolved_vlm_api_key),
            env_path=str(ROOT_ENV_PATH),
            runtime_settings_writable=settings.runtime_settings_writable,
        )

    def update_vlm_settings(self, payload: VlmSettingsUpdate) -> VlmSettingsRead:
        settings = get_settings()
        if not settings.runtime_settings_writable:
            raise HTTPException(status_code=403, detail="Runtime settings are disabled in production. Use hosting environment variables.")

        provider = payload.provider.strip().lower() or "auto"
        if provider not in {"auto", "openai", "openai_compatible", "google", "gemini", "google_genai", "mock"}:
            raise HTTPException(status_code=400, detail="Use auto, mock, openai_compatible, or google_genai")

        inference_params = inference_params_from_settings_payload(payload, settings.resolved_vlm_inference_params)
        legacy_inference_keys = {
            "VLM_REASONING_EFFORT",
            "VLM_VERBOSITY",
            "VLM_MAX_COMPLETION_TOKENS",
            "VLM_TOP_P",
            "VLM_SERVICE_TIER",
        }
        updates = {
            "VLM_PROVIDER": provider,
            "VLM_MODEL_NAME": payload.model_name.strip(),
            "VLM_BASE_URL": (payload.base_url or "").strip(),
            "LIBREOFFICE_PATH": (payload.libreoffice_path or "").strip() or DEFAULT_LIBREOFFICE_PATH,
            "VLM_INFERENCE_PARAMS": VlmInferenceParams.from_mapping(inference_params).to_env_json(),
            "WORKFLOW_MAX_WORKERS": str(payload.workflow_max_workers or settings.workflow_max_workers),
            "VLM_MAX_CONCURRENT_REQUESTS": str(payload.vlm_max_concurrent_requests or settings.vlm_max_concurrent_requests),
            "VLM_TIMEOUT_SECONDS": str(payload.vlm_timeout_seconds or settings.vlm_timeout_seconds),
            "KIE_FIELD_GROUP_SIZE": str(payload.kie_field_group_size or settings.kie_field_group_size),
        }
        api_key = (payload.api_key or "").strip()
        if api_key:
            updates["VLM_API_KEY"] = api_key

        upsert_root_env(updates, include_defaults=True, remove_keys={"BATCH_MAX_WORKERS", "VLM_TEMPERATURE", *legacy_inference_keys})
        for key, value in updates.items():
            os.environ[key] = value
        for key in legacy_inference_keys:
            os.environ.pop(key, None)
        os.environ.pop("VLM_TEMPERATURE", None)
        get_settings.cache_clear()
        return self.read_vlm_settings()


def inference_params_from_settings_payload(payload: VlmSettingsUpdate, current: dict[str, str]) -> dict[str, str]:
    values: dict[str, Any] = {**current}
    if payload.inference_params is not None:
        values.update(payload.inference_params)
    else:
        explicit_values = {
            "reasoning_effort": payload.reasoning_effort,
            "thinking": payload.reasoning_effort,
            "temperature": payload.temperature,
            "verbosity": payload.verbosity,
            "max_completion_tokens": payload.max_completion_tokens,
            "top_p": payload.top_p,
            "service_tier": payload.service_tier,
        }
        values.update({key: value for key, value in explicit_values.items() if value is not None})
    return normalize_vlm_inference_params(values)
