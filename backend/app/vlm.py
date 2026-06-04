import asyncio
import base64
from contextlib import asynccontextmanager, contextmanager
import functools
import json
import mimetypes
import threading
import time
from typing import Any

from app.config import get_settings
from app.prompts.classifier import (
    DOCUMENT_CLASSIFIER_PROMPT,
    build_classification_output_schema as _classification_output_schema,
    build_classification_prompt as _build_classification_prompt,
)
from app.prompts.common import image_inputs_from_paths as _image_inputs_from_paths
from app.prompts.kie import (
    KIE_SYSTEM_PROMPT,
    build_correction_output_schema as _kie_correction_output_schema,
    build_correction_prompt as _build_kie_correction_prompt,
    build_extraction_prompt as _build_user_prompt,
    build_judgement_output_schema as _kie_judgement_output_schema,
    build_judgement_prompt as _build_kie_judgement_prompt,
    build_structured_output_schema,
)
from app.prompts.required_checker import (
    REQUIRED_FIELD_CHECKER_PROMPT,
    build_required_field_output_schema as _required_field_output_schema,
    build_required_field_prompt as _build_required_field_prompt,
)
from app.prompts.schema_recommendation import (
    REQUIRED_FIELD_CHECKLIST_RECOMMENDATION_PROMPT,
    SCHEMA_DESCRIPTION_PROMPT,
    SCHEMA_RECOMMENDATION_PROMPT,
    build_required_field_checklist_recommendation_output_schema as _required_field_checklist_recommendation_output_schema,
    build_required_field_checklist_recommendation_prompt as _build_required_field_checklist_recommendation_prompt,
    build_schema_description_output_schema as _schema_description_output_schema,
    build_schema_description_prompt as _build_schema_description_prompt,
    build_schema_recommendation_output_schema as _schema_recommendation_output_schema,
    build_schema_recommendation_prompt as _build_schema_recommendation_prompt,
)
from app.schemas import ClassCandidate, FieldDefinition, RequiredFieldItem, SchemaRegion
from app.storage import read_storage_bytes, storage_ref_name


SYSTEM_PROMPT = KIE_SYSTEM_PROMPT


class VlmRuntimeError(RuntimeError):
    def __init__(self, code: str, message: str, hint: str | None = None):
        self.code = code
        self.message = message
        self.hint = hint
        super().__init__(self.as_text())

    def as_text(self) -> str:
        text = f"{self.code}: {self.message}"
        if self.hint:
            text = f"{text} Hint: {self.hint}"
        return text

    def as_detail(self) -> dict[str, str]:
        detail = {"code": self.code, "message": self.message}
        if self.hint:
            detail["hint"] = self.hint
        return detail


def vlm_error_detail(exc: Exception) -> str | dict[str, str]:
    if isinstance(exc, VlmRuntimeError):
        return exc.as_detail()
    return str(exc)


_VLM_SLOT_LOCK = threading.Lock()
_VLM_SLOT_LIMIT = 0
_VLM_SLOT_SEMAPHORE: threading.BoundedSemaphore | None = None
_VLM_ACTIVE_REQUESTS = 0
_VLM_WAITING_REQUESTS = 0
_VLM_ASYNC_SLOT_POLL_SECONDS = 0.02


@contextmanager
def _vlm_request_slot():
    semaphore = _vlm_request_semaphore()
    _adjust_vlm_runtime_counter(waiting_delta=1)
    semaphore.acquire()
    _adjust_vlm_runtime_counter(waiting_delta=-1, active_delta=1)
    try:
        yield
    finally:
        _adjust_vlm_runtime_counter(active_delta=-1)
        semaphore.release()


def _vlm_request_semaphore() -> threading.BoundedSemaphore:
    global _VLM_SLOT_LIMIT, _VLM_SLOT_SEMAPHORE
    limit = max(1, get_settings().vlm_max_concurrent_requests)
    with _VLM_SLOT_LOCK:
        if _VLM_SLOT_SEMAPHORE is None or _VLM_SLOT_LIMIT != limit:
            _VLM_SLOT_LIMIT = limit
            _VLM_SLOT_SEMAPHORE = threading.BoundedSemaphore(limit)
        return _VLM_SLOT_SEMAPHORE


def _adjust_vlm_runtime_counter(*, active_delta: int = 0, waiting_delta: int = 0) -> None:
    global _VLM_ACTIVE_REQUESTS, _VLM_WAITING_REQUESTS
    if not active_delta and not waiting_delta:
        return
    with _VLM_SLOT_LOCK:
        _VLM_ACTIVE_REQUESTS = max(0, _VLM_ACTIVE_REQUESTS + active_delta)
        _VLM_WAITING_REQUESTS = max(0, _VLM_WAITING_REQUESTS + waiting_delta)


def vlm_runtime_counters() -> dict[str, int]:
    with _VLM_SLOT_LOCK:
        return {
            "vlm_active_count": _VLM_ACTIVE_REQUESTS,
            "vlm_waiting_count": _VLM_WAITING_REQUESTS,
            "vlm_limit": max(1, get_settings().vlm_max_concurrent_requests),
        }


@asynccontextmanager
async def _vlm_request_slot_async():
    semaphore = _vlm_request_semaphore()
    acquired = False
    _adjust_vlm_runtime_counter(waiting_delta=1)
    try:
        while True:
            if semaphore.acquire(blocking=False):
                acquired = True
                break
            await asyncio.sleep(_VLM_ASYNC_SLOT_POLL_SECONDS)
        _adjust_vlm_runtime_counter(waiting_delta=-1, active_delta=1)
        try:
            yield
        finally:
            _adjust_vlm_runtime_counter(active_delta=-1)
            semaphore.release()
    except BaseException:
        if not acquired:
            _adjust_vlm_runtime_counter(waiting_delta=-1)
        raise


def _invoke_vlm_with_limit(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
    api_style: str,
) -> dict[str, Any]:
    max_attempts = max(1, get_settings().vlm_max_retries + 1)
    for attempt in range(max_attempts):
        try:
            with _vlm_request_slot():
                return _invoke_structured_llm(system_prompt, prompt, image_inputs, output_schema, api_style)
        except VlmRuntimeError as exc:
            if attempt >= max_attempts - 1 or not _is_retryable_vlm_error(exc):
                raise
            time.sleep(_vlm_retry_delay_seconds(attempt))
    raise VlmRuntimeError("VLM_PROVIDER_REQUEST_FAILED", "VLM request failed after retries.")


async def _invoke_vlm_with_limit_async(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
    api_style: str,
) -> dict[str, Any]:
    max_attempts = max(1, get_settings().vlm_max_retries + 1)
    for attempt in range(max_attempts):
        try:
            async with _vlm_request_slot_async():
                return await _invoke_structured_llm_with_timeout_async(system_prompt, prompt, image_inputs, output_schema, api_style)
        except VlmRuntimeError as exc:
            if attempt >= max_attempts - 1 or not _is_retryable_vlm_error(exc):
                raise
            retry_delay = _vlm_retry_delay_seconds(attempt)
        await asyncio.sleep(retry_delay)
    raise VlmRuntimeError("VLM_PROVIDER_REQUEST_FAILED", "VLM request failed after retries.")


async def run_sync_with_vlm_limit_async(func, *args, **kwargs) -> Any:
    async with _vlm_request_slot_async():
        return await asyncio.to_thread(functools.partial(func, *args, **kwargs))


def _is_retryable_vlm_error(exc: VlmRuntimeError) -> bool:
    if exc.code != "VLM_PROVIDER_REQUEST_FAILED":
        return False
    text = f"{exc.message} {exc.hint or ''}".lower()
    retryable_fragments = (
        "broken pipe",
        "connection",
        "connection reset",
        "connection aborted",
        "timeout",
        "timed out",
        "temporarily unavailable",
        "unavailable",
        "rate limit",
        "resource exhausted",
        "429",
        "500",
        "502",
        "503",
        "504",
    )
    return any(fragment in text for fragment in retryable_fragments)


def _vlm_retry_delay_seconds(attempt: int) -> float:
    return min(4.0, 0.5 * (2 ** attempt))


def format_vlm_exception(exc: Exception) -> str:
    if isinstance(exc, VlmRuntimeError):
        return exc.as_text()
    return str(exc)


def extract_with_vlm(
    fields: list[FieldDefinition],
    image_paths: list[str] | None = None,
    image_inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_extraction(fields)

    _ensure_vlm_credentials(settings)

    prompt = _build_user_prompt(fields)
    inputs = image_inputs or _image_inputs_from_paths(image_paths or [])
    return _invoke_vlm_with_limit(SYSTEM_PROMPT, prompt, inputs, build_structured_output_schema(fields), api_style)


async def extract_with_vlm_async(
    fields: list[FieldDefinition],
    image_paths: list[str] | None = None,
    image_inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_extraction(fields)

    _ensure_vlm_credentials(settings)

    prompt = _build_user_prompt(fields)
    inputs = image_inputs or _image_inputs_from_paths(image_paths or [])
    return await _invoke_vlm_with_limit_async(SYSTEM_PROMPT, prompt, inputs, build_structured_output_schema(fields), api_style)


def recommend_schema_with_vlm(image_paths: list[str]) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_schema_recommendation()

    _ensure_vlm_credentials(settings)

    prompt = _build_schema_recommendation_prompt()
    return _invoke_vlm_with_limit(
        SCHEMA_RECOMMENDATION_PROMPT,
        prompt,
        _image_inputs_from_paths(image_paths),
        _schema_recommendation_output_schema(),
        api_style,
    )


def recommend_schema_description_with_vlm(
    image_paths: list[str] | None = None,
    *,
    schema_name: str,
    current_description: str | None,
    fields: list[FieldDefinition],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_schema_description_recommendation(schema_name, fields)

    _ensure_vlm_credentials(settings)

    prompt = _build_schema_description_prompt(schema_name, current_description, fields)
    return _invoke_vlm_with_limit(
        SCHEMA_DESCRIPTION_PROMPT,
        prompt,
        [],
        _schema_description_output_schema(),
        api_style,
    )


def classify_document_with_vlm(
    classes: list[ClassCandidate],
    allow_unknown: bool,
    image_paths: list[str],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_classification(classes, allow_unknown)

    _ensure_vlm_credentials(settings)
    prompt = _build_classification_prompt(classes, allow_unknown)
    return _invoke_vlm_with_limit(
        DOCUMENT_CLASSIFIER_PROMPT,
        prompt,
        _image_inputs_from_paths(image_paths),
        _classification_output_schema(classes, allow_unknown),
        api_style,
    )


async def classify_document_with_vlm_async(
    classes: list[ClassCandidate],
    allow_unknown: bool,
    image_paths: list[str],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_classification(classes, allow_unknown)

    _ensure_vlm_credentials(settings)
    prompt = _build_classification_prompt(classes, allow_unknown)
    return await _invoke_vlm_with_limit_async(
        DOCUMENT_CLASSIFIER_PROMPT,
        prompt,
        _image_inputs_from_paths(image_paths),
        _classification_output_schema(classes, allow_unknown),
        api_style,
    )


def check_required_fields_with_vlm(
    items: list[RequiredFieldItem],
    regions: list[SchemaRegion],
    image_paths: list[str] | None = None,
    image_inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_required_field_check(items)

    _ensure_vlm_credentials(settings)
    prompt = _build_required_field_prompt(items, regions)
    inputs = image_inputs or _image_inputs_from_paths(image_paths or [])
    return _invoke_vlm_with_limit(
        REQUIRED_FIELD_CHECKER_PROMPT,
        prompt,
        inputs,
        _required_field_output_schema(items),
        api_style,
    )


async def check_required_fields_with_vlm_async(
    items: list[RequiredFieldItem],
    regions: list[SchemaRegion],
    image_paths: list[str] | None = None,
    image_inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_required_field_check(items)

    _ensure_vlm_credentials(settings)
    prompt = _build_required_field_prompt(items, regions)
    inputs = image_inputs or _image_inputs_from_paths(image_paths or [])
    return await _invoke_vlm_with_limit_async(
        REQUIRED_FIELD_CHECKER_PROMPT,
        prompt,
        inputs,
        _required_field_output_schema(items),
        api_style,
    )


def judge_extraction_with_vlm(
    field: FieldDefinition,
    initial_value: Any,
    initial_evidence: str | None,
    image_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_extraction_judgement(field)

    _ensure_vlm_credentials(settings)
    prompt = _build_kie_judgement_prompt(field, initial_value, initial_evidence)
    return _invoke_vlm_with_limit(
        SYSTEM_PROMPT,
        prompt,
        image_inputs,
        _kie_judgement_output_schema(),
        api_style,
    )


async def judge_extraction_with_vlm_async(
    field: FieldDefinition,
    initial_value: Any,
    initial_evidence: str | None,
    image_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_extraction_judgement(field)

    _ensure_vlm_credentials(settings)
    prompt = _build_kie_judgement_prompt(field, initial_value, initial_evidence)
    return await _invoke_vlm_with_limit_async(
        SYSTEM_PROMPT,
        prompt,
        image_inputs,
        _kie_judgement_output_schema(),
        api_style,
    )


def correct_extraction_with_vlm(
    field: FieldDefinition,
    initial_value: Any,
    initial_evidence: str | None,
    judgement_reason: str | None,
    image_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_extraction_correction(field, initial_value, initial_evidence)

    _ensure_vlm_credentials(settings)
    prompt = _build_kie_correction_prompt(field, initial_value, initial_evidence, judgement_reason)
    return _invoke_vlm_with_limit(
        SYSTEM_PROMPT,
        prompt,
        image_inputs,
        _kie_correction_output_schema(field),
        api_style,
    )


async def correct_extraction_with_vlm_async(
    field: FieldDefinition,
    initial_value: Any,
    initial_evidence: str | None,
    judgement_reason: str | None,
    image_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_extraction_correction(field, initial_value, initial_evidence)

    _ensure_vlm_credentials(settings)
    prompt = _build_kie_correction_prompt(field, initial_value, initial_evidence, judgement_reason)
    return await _invoke_vlm_with_limit_async(
        SYSTEM_PROMPT,
        prompt,
        image_inputs,
        _kie_correction_output_schema(field),
        api_style,
    )


def recommend_required_field_checklist_with_vlm(image_paths: list[str]) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_required_field_checklist_recommendation()

    _ensure_vlm_credentials(settings)
    prompt = _build_required_field_checklist_recommendation_prompt()
    return _invoke_vlm_with_limit(
        REQUIRED_FIELD_CHECKLIST_RECOMMENDATION_PROMPT,
        prompt,
        _image_inputs_from_paths(image_paths),
        _required_field_checklist_recommendation_output_schema(),
        api_style,
    )


def resolve_vlm_api_style(settings=None) -> str:
    settings = settings or get_settings()
    provider = (settings.vlm_provider or "auto").strip().lower()
    api_key = settings.resolved_vlm_api_key or ""
    base_url = (settings.vlm_base_url or "").strip()

    if provider == "mock":
        return "mock"
    if provider in {"google", "gemini", "google_genai"}:
        return "google_genai"
    if provider in {"openai_compatible", "openai"} and api_key.startswith("AIza") and not base_url:
        return "google_genai"
    if provider in {"auto", ""}:
        if base_url:
            return "openai_compatible"
        if api_key.startswith("AIza"):
            return "google_genai"
        return "openai_compatible"
    if provider in {"openai_compatible", "openai"}:
        return "openai_compatible"
    raise VlmRuntimeError(
        "VLM_PROVIDER_UNSUPPORTED",
        "Unsupported VLM_PROVIDER.",
        "Use auto, mock, openai_compatible, or google_genai.",
    )


def _ensure_vlm_credentials(settings) -> None:
    if not settings.resolved_vlm_api_key or not settings.resolved_vlm_model_name:
        raise VlmRuntimeError(
            "VLM_CREDENTIALS_MISSING",
            "VLM API key and model name are required.",
            "Save API key and model name in Home Setting, or use VLM_PROVIDER=mock for a local demo.",
        )


def _invoke_structured_llm(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
    api_style: str,
) -> dict[str, Any]:
    if api_style == "google_genai":
        return _invoke_google_genai(system_prompt, prompt, image_inputs, output_schema)
    if api_style != "openai_compatible":
        raise VlmRuntimeError("VLM_API_STYLE_UNSUPPORTED", f"Unsupported VLM API style: {api_style}")
    content = _build_multimodal_content(prompt, image_inputs)
    return _invoke_openai_compatible(system_prompt, content, output_schema)


async def _invoke_structured_llm_async(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
    api_style: str,
) -> dict[str, Any]:
    if api_style == "google_genai":
        return await _invoke_google_genai_async(system_prompt, prompt, image_inputs, output_schema)
    if api_style != "openai_compatible":
        raise VlmRuntimeError("VLM_API_STYLE_UNSUPPORTED", f"Unsupported VLM API style: {api_style}")
    content = await asyncio.to_thread(_build_multimodal_content, prompt, image_inputs)
    return await _invoke_openai_compatible_async(system_prompt, content, output_schema)


async def _invoke_structured_llm_with_timeout_async(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
    api_style: str,
) -> dict[str, Any]:
    timeout_seconds = max(1, get_settings().vlm_timeout_seconds)
    try:
        return await asyncio.wait_for(
            _invoke_structured_llm_async(system_prompt, prompt, image_inputs, output_schema, api_style),
            timeout=timeout_seconds,
        )
    except TimeoutError as exc:
        raise VlmRuntimeError(
            "VLM_PROVIDER_REQUEST_FAILED",
            f"VLM request timed out after {timeout_seconds} seconds.",
        ) from exc


def _invoke_openai_compatible(system_prompt: str, content: list[dict[str, Any]], output_schema: dict[str, Any]) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(**_build_llm_kwargs())
    structured_llm = llm.with_structured_output(
        output_schema,
        method="json_schema",
        strict=True,
    )

    try:
        response = structured_llm.invoke([SystemMessage(content=system_prompt), HumanMessage(content=content)])
    except VlmRuntimeError:
        raise
    except Exception as exc:
        raise VlmRuntimeError(
            "VLM_PROVIDER_REQUEST_FAILED",
            f"OpenAI-compatible VLM request failed: {_sanitize_provider_error(exc)}",
        ) from exc
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if isinstance(response, dict):
        return response
    if isinstance(response, str):
        raise VlmRuntimeError("VLM_RESPONSE_STRING", "VLM returned a string instead of a structured object.")
    raise VlmRuntimeError("VLM_RESPONSE_UNSUPPORTED", "VLM returned an unsupported structured response.")


async def _invoke_openai_compatible_async(system_prompt: str, content: list[dict[str, Any]], output_schema: dict[str, Any]) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(**_build_llm_kwargs())
    structured_llm = llm.with_structured_output(
        output_schema,
        method="json_schema",
        strict=True,
    )

    try:
        response = await structured_llm.ainvoke([SystemMessage(content=system_prompt), HumanMessage(content=content)])
    except VlmRuntimeError:
        raise
    except Exception as exc:
        raise VlmRuntimeError(
            "VLM_PROVIDER_REQUEST_FAILED",
            f"OpenAI-compatible VLM request failed: {_sanitize_provider_error(exc)}",
        ) from exc
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if isinstance(response, dict):
        return response
    if isinstance(response, str):
        raise VlmRuntimeError("VLM_RESPONSE_STRING", "VLM returned a string instead of a structured object.")
    raise VlmRuntimeError("VLM_RESPONSE_UNSUPPORTED", "VLM returned an unsupported structured response.")


def _invoke_google_genai(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
) -> dict[str, Any]:
    settings = get_settings()
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise VlmRuntimeError(
            "VLM_GOOGLE_GENAI_MISSING",
            "Gemini native mode requires google-genai.",
            "Run: uv pip install -e 'backend[dev]'",
        ) from exc

    contents: list[Any] = [prompt]
    for image_input in image_inputs:
        label = image_input.get("label")
        if label:
            contents.append(label)
        image_ref = image_input["path"]
        contents.append(types.Part.from_bytes(data=read_storage_bytes(image_ref), mime_type=_mime_type_for_ref(image_ref)))

    config = _build_google_generation_config(system_prompt, output_schema)
    client = genai.Client(api_key=settings.resolved_vlm_api_key)
    try:
        response = client.models.generate_content(
            model=settings.resolved_vlm_model_name,
            contents=contents,
            config=config,
        )
    except VlmRuntimeError:
        raise
    except Exception as exc:
        raise VlmRuntimeError(
            "VLM_PROVIDER_REQUEST_FAILED",
            f"Google GenAI VLM request failed: {_sanitize_provider_error(exc)}",
        ) from exc
    return _coerce_structured_response(response)


async def _invoke_google_genai_async(
    system_prompt: str,
    prompt: str,
    image_inputs: list[dict[str, str]],
    output_schema: dict[str, Any],
) -> dict[str, Any]:
    settings = get_settings()
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise VlmRuntimeError(
            "VLM_GOOGLE_GENAI_MISSING",
            "Gemini native mode requires google-genai.",
            "Run: uv pip install -e 'backend[dev]'",
        ) from exc

    contents: list[Any] = [prompt]
    for image_input in image_inputs:
        label = image_input.get("label")
        if label:
            contents.append(label)
        image_ref = image_input["path"]
        contents.append(types.Part.from_bytes(data=read_storage_bytes(image_ref), mime_type=_mime_type_for_ref(image_ref)))

    config = _build_google_generation_config(system_prompt, output_schema)
    client = genai.Client(api_key=settings.resolved_vlm_api_key)
    async_client = client.aio
    try:
        response = await async_client.models.generate_content(
            model=settings.resolved_vlm_model_name,
            contents=contents,
            config=config,
        )
    except VlmRuntimeError:
        raise
    except Exception as exc:
        raise VlmRuntimeError(
            "VLM_PROVIDER_REQUEST_FAILED",
            f"Google GenAI VLM request failed: {_sanitize_provider_error(exc)}",
        ) from exc
    finally:
        close_async = getattr(async_client, "aclose", None)
        if callable(close_async):
            await close_async()
        close_sync = getattr(client, "close", None)
        if callable(close_sync):
            close_sync()
    return _coerce_structured_response(response)


def _build_llm_kwargs() -> dict[str, Any]:
    settings = get_settings()
    llm_kwargs: dict[str, Any] = {
        "model": settings.resolved_vlm_model_name,
        "api_key": settings.resolved_vlm_api_key,
        "temperature": settings.vlm_temperature,
        "timeout": settings.vlm_timeout_seconds,
        "max_retries": settings.vlm_max_retries,
    }
    if settings.vlm_base_url:
        llm_kwargs["base_url"] = settings.vlm_base_url

    reasoning_effort = _clean_optional_text(settings.vlm_reasoning_effort)
    if reasoning_effort:
        llm_kwargs["reasoning_effort"] = reasoning_effort

    verbosity = _clean_optional_text(settings.vlm_verbosity)
    if verbosity:
        llm_kwargs["verbosity"] = verbosity

    max_completion_tokens = _optional_int(settings.vlm_max_completion_tokens)
    if max_completion_tokens is not None:
        llm_kwargs["max_completion_tokens"] = max_completion_tokens

    top_p = _optional_float(settings.vlm_top_p)
    if top_p is not None:
        llm_kwargs["top_p"] = top_p

    service_tier = _clean_optional_text(settings.vlm_service_tier)
    if service_tier:
        llm_kwargs["service_tier"] = service_tier

    return llm_kwargs


def _build_google_generation_config(system_prompt: str, output_schema: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    config: dict[str, Any] = {
        "system_instruction": system_prompt,
        "temperature": settings.vlm_temperature,
        "response_mime_type": "application/json",
        "response_json_schema": output_schema,
    }
    max_output_tokens = _optional_int(settings.vlm_max_completion_tokens)
    if max_output_tokens is not None:
        config["max_output_tokens"] = max_output_tokens

    top_p = _optional_float(settings.vlm_top_p)
    if top_p is not None:
        config["top_p"] = top_p

    thinking_config = _google_thinking_config(settings.vlm_reasoning_effort)
    if thinking_config:
        config["thinking_config"] = thinking_config

    return config


def _google_thinking_config(reasoning_effort: str | None) -> dict[str, Any] | None:
    effort = _clean_optional_text(reasoning_effort)
    if not effort:
        return None
    normalized = effort.lower()
    if normalized in {"none", "off", "instant", "0"}:
        return {"thinking_budget": 0}
    if normalized in {"minimal", "low", "medium", "high"}:
        return {"thinking_level": normalized}
    return {"thinking_level": normalized}


def _coerce_structured_response(response: Any) -> dict[str, Any]:
    parsed = getattr(response, "parsed", None)
    if hasattr(parsed, "model_dump"):
        return parsed.model_dump()
    if isinstance(parsed, dict):
        return parsed

    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        try:
            loaded = json.loads(text)
        except json.JSONDecodeError as exc:
            raise VlmRuntimeError("VLM_RESPONSE_INVALID_JSON", "VLM returned invalid JSON text.") from exc
        if isinstance(loaded, dict):
            return loaded
        raise VlmRuntimeError("VLM_RESPONSE_JSON_NOT_OBJECT", "VLM returned structured JSON that is not an object.")

    if isinstance(response, dict):
        return response
    if isinstance(response, str):
        raise VlmRuntimeError("VLM_RESPONSE_STRING", "VLM returned a string instead of a structured object.")
    raise VlmRuntimeError("VLM_RESPONSE_UNSUPPORTED", "VLM returned an unsupported structured response.")


def _clean_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _optional_int(value: str | None) -> int | None:
    cleaned = _clean_optional_text(value)
    if cleaned is None:
        return None
    try:
        return int(cleaned)
    except ValueError as exc:
        raise VlmRuntimeError("VLM_SETTING_INVALID_INTEGER", f"Invalid integer VLM setting: {cleaned}") from exc


def _optional_float(value: str | None) -> float | None:
    cleaned = _clean_optional_text(value)
    if cleaned is None:
        return None
    try:
        return float(cleaned)
    except ValueError as exc:
        raise VlmRuntimeError("VLM_SETTING_INVALID_NUMERIC", f"Invalid numeric VLM setting: {cleaned}") from exc


def _sanitize_provider_error(exc: Exception) -> str:
    settings = get_settings()
    message = str(exc) or exc.__class__.__name__
    for secret in [settings.resolved_vlm_api_key, settings.openai_api_key, settings.vlm_api_key]:
        if secret:
            message = message.replace(secret, "[redacted]")
            if len(secret) > 8:
                message = message.replace(secret[:8], "[redacted]")
    return message


def _mime_type_for_ref(ref: str) -> str:
    return mimetypes.guess_type(storage_ref_name(ref))[0] or "image/png"


def _build_multimodal_content(prompt: str, image_inputs: list[dict[str, str]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for image_input in image_inputs:
        label = image_input.get("label")
        if label:
            content.append({"type": "text", "text": label})
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _image_to_data_url(image_input["path"])},
            }
        )
    return content


def _image_to_data_url(ref: str) -> str:
    mime_type = _mime_type_for_ref(ref)
    encoded = base64.b64encode(read_storage_bytes(ref)).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _mock_extraction(fields: list[FieldDefinition]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for field in fields:
        if field.output_format == "float":
            value: Any = "1,234.50"
        elif field.output_format == "date":
            value = "2026.05.19"
        elif field.output_format == "bool":
            value = "예"
        else:
            value = f"Sample {field.key_name}"
        values[field.key_name] = {
            "value": value,
            "page": field.region.page if field.region else 1,
            "evidence": f"Mock evidence for {field.key_name}" + (" from extraction region" if field.region_id or field.region else ""),
            "confidence": 0.86,
        }
    return values


def _mock_extraction_judgement(field: FieldDefinition) -> dict[str, Any]:
    return {
        "judgement_status": "correct",
        "reason": f"Mock judgement accepted the first-stage value for {field.key_name}.",
        "confidence": 0.9,
        "evidence": f"Mock judgement evidence for {field.key_name}",
    }


def _mock_extraction_correction(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> dict[str, Any]:
    return {
        "value": initial_value,
        "page": field.region.page if field.region else 1,
        "evidence": initial_evidence or f"Mock correction evidence for {field.key_name}",
        "confidence": 0.86,
        "correction_reason": f"Mock correction preserved the first-stage value for {field.key_name}.",
    }


def _mock_schema_recommendation() -> dict[str, Any]:
    return {
        "name": "ai_recommended_schema",
        "display_name": "AI Recommended Schema",
        "description": "Mock schema recommendation for local demo and UI testing.",
        "document_type": "demo_document",
        "language": "ko",
        "reasoning": "Mock mode returns deterministic Korean field names to exercise the localized schema UI.",
        "fields": [
            {
                "key_name": "문서번호",
                "description": "Primary document, invoice, receipt, or application number visible near the top.",
                "output_format": "string",
            },
            {
                "key_name": "문서일자",
                "description": "Main issued, submitted, or effective date printed on the document.",
                "output_format": "date",
            },
            {
                "key_name": "발급기관",
                "description": "Organization, bank, vendor, or issuing body that issued the document.",
                "output_format": "string",
            },
            {
                "key_name": "수신자",
                "description": "Person or organization that the document is addressed to or belongs to.",
                "output_format": "string",
            },
            {
                "key_name": "금액",
                "description": "Final total, balance, or transaction amount if one is visible.",
                "output_format": "float",
            },
        ],
    }


def _mock_schema_description_recommendation(schema_name: str, fields: list[FieldDefinition]) -> dict[str, Any]:
    field_names = ", ".join(field.key_name for field in fields[:6])
    return {
        "description": f"{schema_name} schema extracts these user-defined fields from the document: {field_names}.",
        "reasoning": "Mock mode generated a deterministic description from the current field list.",
    }


def _mock_classification(classes: list[ClassCandidate], allow_unknown: bool) -> dict[str, Any]:
    if classes:
        selected = classes[0]
        return {
            "status": "classified",
            "class_name": selected.class_name,
            "confidence": 0.88,
            "reason": f"Mock mode selected the first candidate class: {selected.class_name}.",
            "evidence": selected.signals[:3] or [selected.description],
        }
    return {
        "status": "unknown",
        "class_name": None,
        "confidence": 0.0,
        "reason": "Mock mode found no candidate classes.",
        "evidence": [],
    }


def _mock_required_field_check(items: list[RequiredFieldItem]) -> dict[str, Any]:
    checked_items = []
    missing_required = False
    for index, item in enumerate(items):
        name = item.item_name.lower()
        status = "uncertain" if item.evidence_type == "checkbox" or "체크" in name or "checkbox" in name else "present"
        if item.required and status != "present":
            missing_required = True
        checked_items.append(
            {
                "item_name": item.item_name,
                "status": status,
                "confidence": 0.84 if status == "present" else 0.58,
                "evidence": f"Mock evidence for {item.item_name}",
                "page": 1,
            }
        )
    return {
        "overall_status": "needs_review" if missing_required else "complete",
        "items": checked_items,
    }


def _mock_required_field_checklist_recommendation() -> dict[str, Any]:
    return {
        "name": "ai_recommended_checklist",
        "description": "문서 접수 전에 눈으로 확인해야 하는 필수 항목 중심의 mock 체크리스트입니다.",
        "reasoning": "Mock mode returns deterministic Korean checklist items to exercise the Required Field Checker recommendation UI.",
        "regions": [
            {
                "id": "signature_area",
                "name": "서명/날인 영역",
                "page": 1,
                "x": 0.55,
                "y": 0.68,
                "width": 0.35,
                "height": 0.18,
            }
        ],
        "items": [
            {
                "item_name": "성명",
                "description": "작성자 또는 대상자의 성명이 인쇄 또는 필기로 존재하는지 확인합니다.",
                "evidence_type": "text_or_handwriting",
                "required": True,
                "region_id": None,
            },
            {
                "item_name": "작성일",
                "description": "문서 작성일, 제출일, 발급일 중 업무상 필요한 날짜가 보이는지 확인합니다.",
                "evidence_type": "text_or_handwriting",
                "required": True,
                "region_id": None,
            },
            {
                "item_name": "서명/날인",
                "description": "하단 서명 또는 도장 영역에 서명, 날인, 직인이 존재하는지 확인합니다.",
                "evidence_type": "signature_or_stamp",
                "required": True,
                "region_id": "signature_area",
            },
            {
                "item_name": "동의 체크",
                "description": "필수 동의 또는 확인 체크박스가 선택되어 있는지 확인합니다.",
                "evidence_type": "checkbox",
                "required": True,
                "region_id": None,
            },
        ],
    }
