import base64
import json
import mimetypes
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.schemas import FieldDefinition


SYSTEM_PROMPT = """You are a key information extraction engine.
Extract only the fields defined by the schema.
Do not return keys that are not in the schema.
If a value is not visible or uncertain, return null.
Preserve the document's original wording when possible.
Return data that matches the requested structured output schema."""

SCHEMA_RECOMMENDATION_PROMPT = """You are a document schema design assistant.
Look at the uploaded document images and recommend practical key information fields for extraction.
Return concise key names in the document's primary language.
For Korean documents, key_name values should be natural Korean labels such as 성명, 계급, 군번, 소집기간, 훈련장소.
For English documents, key_name values should be concise English snake_case labels.
Do not add a separate field display label; key_name is what users will see in the UI and exports.
Each field description must explain where or how to find the value in the document.
Use only these output formats: string, float, date, bool."""


def build_structured_output_schema(fields: list[FieldDefinition]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in fields:
        properties[field.key_name] = _json_schema_for_field(field)
        required.append(field.key_name)

    return {
        "title": "KeyInformationExtraction",
        "description": "Structured extraction result containing only user-defined schema fields.",
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": required,
    }


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
    return _invoke_structured_llm(SYSTEM_PROMPT, prompt, inputs, build_structured_output_schema(fields), api_style)


def recommend_schema_with_vlm(image_paths: list[str]) -> dict[str, Any]:
    settings = get_settings()
    api_style = resolve_vlm_api_style(settings)
    if api_style == "mock":
        return _mock_schema_recommendation()

    _ensure_vlm_credentials(settings)

    prompt = (
        "Recommend 5 to 8 fields that a user is likely to want from this document. "
        "Prefer visible business-critical fields over generic metadata. "
        "Choose key_name values in the document's primary language."
    )
    return _invoke_structured_llm(
        SCHEMA_RECOMMENDATION_PROMPT,
        prompt,
        _image_inputs_from_paths(image_paths),
        _schema_recommendation_output_schema(),
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
    raise RuntimeError("Unsupported VLM_PROVIDER. Use auto, mock, openai_compatible, or google_genai.")


def _ensure_vlm_credentials(settings) -> None:
    if not settings.resolved_vlm_api_key or not settings.resolved_vlm_model_name:
        raise RuntimeError("VLM API key and model name are required")


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
        raise RuntimeError(f"Unsupported VLM API style: {api_style}")
    content = _build_multimodal_content(prompt, image_inputs)
    return _invoke_openai_compatible(system_prompt, content, output_schema)


def _invoke_openai_compatible(system_prompt: str, content: list[dict[str, Any]], output_schema: dict[str, Any]) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(**_build_llm_kwargs())
    structured_llm = llm.with_structured_output(
        output_schema,
        method="json_schema",
        strict=True,
    )

    response = structured_llm.invoke([SystemMessage(content=system_prompt), HumanMessage(content=content)])
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if isinstance(response, dict):
        return response
    if isinstance(response, str):
        raise RuntimeError("VLM returned a string instead of a structured object")
    raise RuntimeError("VLM returned an unsupported structured response")


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
        raise RuntimeError("Gemini native mode requires google-genai. Run: uv pip install -e 'backend[dev]'") from exc

    contents: list[Any] = [prompt]
    for image_input in image_inputs:
        label = image_input.get("label")
        if label:
            contents.append(label)
        image_path = Path(image_input["path"])
        contents.append(types.Part.from_bytes(data=image_path.read_bytes(), mime_type=_mime_type_for_path(image_path)))

    config = _build_google_generation_config(system_prompt, output_schema)
    client = genai.Client(api_key=settings.resolved_vlm_api_key)
    response = client.models.generate_content(
        model=settings.resolved_vlm_model_name,
        contents=contents,
        config=config,
    )
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
        loaded = json.loads(text)
        if isinstance(loaded, dict):
            return loaded
        raise RuntimeError("VLM returned structured JSON that is not an object")

    if isinstance(response, dict):
        return response
    if isinstance(response, str):
        raise RuntimeError("VLM returned a string instead of a structured object")
    raise RuntimeError("VLM returned an unsupported structured response")


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
        raise RuntimeError(f"Invalid integer VLM setting: {cleaned}") from exc


def _optional_float(value: str | None) -> float | None:
    cleaned = _clean_optional_text(value)
    if cleaned is None:
        return None
    try:
        return float(cleaned)
    except ValueError as exc:
        raise RuntimeError(f"Invalid numeric VLM setting: {cleaned}") from exc


def _mime_type_for_path(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "image/png"


def _json_schema_for_field(field: FieldDefinition) -> dict[str, Any]:
    json_type = {
        "string": "string",
        "date": "string",
        "float": "number",
        "bool": "boolean",
    }[field.output_format]
    return {
        "type": "object",
        "description": field.description,
        "additionalProperties": False,
        "properties": {
            "value": {"anyOf": [{"type": json_type}, {"type": "null"}]},
            "page": {"anyOf": [{"type": "integer", "minimum": 1}, {"type": "null"}]},
            "evidence": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "confidence": {"anyOf": [{"type": "number", "minimum": 0, "maximum": 1}, {"type": "null"}]},
        },
        "required": ["value", "page", "evidence", "confidence"],
    }


def _schema_recommendation_output_schema() -> dict[str, Any]:
    field_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "key_name": {
                "type": "string",
                "description": "User-facing key for the extracted value, written in the document's primary language.",
            },
            "description": {"type": "string", "description": "Field-level instruction for locating the value."},
            "output_format": {"type": "string", "enum": ["string", "float", "date", "bool"]},
        },
        "required": ["key_name", "description", "output_format"],
    }
    return {
        "title": "KeyInformationSchemaRecommendation",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "name": {"type": "string"},
            "display_name": {"type": "string"},
            "description": {"type": "string"},
            "document_type": {"type": "string"},
            "language": {"type": "string"},
            "reasoning": {"type": "string"},
            "fields": {"type": "array", "minItems": 1, "maxItems": 12, "items": field_schema},
        },
        "required": ["name", "display_name", "description", "document_type", "language", "reasoning", "fields"],
    }


def _build_user_prompt(fields: list[FieldDefinition]) -> str:
    has_regions = any(field.region_id or field.region is not None for field in fields)
    lines = ["Extract these fields from the document images:"]
    for field in fields:
        if field.region_id:
            lines.append(
                f"- {field.key_name} ({field.output_format}): {field.description}. "
                f"Use the full page context, masked full page context, and enlarged cropped extraction region for region_id '{field.region_id}'. "
                "Location words in the description refer to the original page position shown by the masked context. "
                "Use the full page only for layout context, read the value from the crop, and do not use unrelated region crops for this field."
            )
        elif field.region:
            region = field.region
            lines.append(
                f"- {field.key_name} ({field.output_format}): {field.description}. "
                f"Use the full page context, masked full page context, and enlarged extraction region crop for this field on page {region.page}; "
                "location words in the description refer to the original page position."
            )
        else:
            lines.append(f"- {field.key_name} ({field.output_format}): {field.description}. Use the full document pages.")
    if has_regions:
        lines.append(
            "Images are labeled. For region fields, use the full page image for document context, then use the masked full page image "
            "to understand where the region sits in the original page, then use the matching enlarged crop to read the value. "
            "Region images should only affect their matching fields."
        )
    lines.append("Return null for fields that are not visible.")
    return "\n".join(lines)


def _build_multimodal_content(prompt: str, image_inputs: list[dict[str, str]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for image_input in image_inputs:
        label = image_input.get("label")
        if label:
            content.append({"type": "text", "text": label})
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _image_to_data_url(Path(image_input["path"]))},
            }
        )
    return content


def _image_inputs_from_paths(image_paths: list[str]) -> list[dict[str, str]]:
    return [{"path": image_path, "label": f"Full document page {index + 1}"} for index, image_path in enumerate(image_paths)]


def _image_to_data_url(path: Path) -> str:
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
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
                "description": "Organization, bank, vendor, or authority that issued the document.",
                "output_format": "string",
            },
            {
                "key_name": "수신자",
                "description": "Person or organization that the document is addressed to or belongs to.",
                "output_format": "string",
            },
            {
                "key_name": "금액",
                "description": "Final total, balance, transaction amount, or payment amount if one is visible.",
                "output_format": "float",
            },
        ],
    }
