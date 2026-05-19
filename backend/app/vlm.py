import base64
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
Return concise key names in snake_case.
Each field description must explain where or how to find the value in the document.
Use only these output formats: string, float, date, bool."""


def build_structured_output_schema(fields: list[FieldDefinition]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in fields:
        properties[field.key_name] = _json_schema_for_field(field)
        required.append(field.key_name)

    return {
        "title": "KIEExtraction",
        "description": "Structured extraction result containing only user-defined schema fields.",
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": required,
    }


def extract_with_vlm(fields: list[FieldDefinition], image_paths: list[str]) -> dict[str, Any]:
    settings = get_settings()
    provider = settings.vlm_provider.lower()
    if provider == "mock":
        return _mock_extraction(fields)

    api_key = settings.resolved_vlm_api_key
    model_name = settings.resolved_vlm_model_name
    if not api_key or not model_name:
        raise RuntimeError("VLM API key and model name are required")
    if provider != "openai":
        raise RuntimeError("Only openai or mock VLM_PROVIDER is supported in this MVP")

    content = _build_multimodal_content(_build_user_prompt(fields), image_paths)
    return _invoke_structured_llm(SYSTEM_PROMPT, content, build_structured_output_schema(fields))


def recommend_schema_with_vlm(image_paths: list[str]) -> dict[str, Any]:
    settings = get_settings()
    provider = settings.vlm_provider.lower()
    if provider == "mock":
        return _mock_schema_recommendation()

    api_key = settings.resolved_vlm_api_key
    model_name = settings.resolved_vlm_model_name
    if not api_key or not model_name:
        raise RuntimeError("VLM API key and model name are required")
    if provider != "openai":
        raise RuntimeError("Only openai or mock VLM_PROVIDER is supported in this MVP")

    prompt = (
        "Recommend 5 to 8 fields that a user is likely to want from this document. "
        "Prefer visible business-critical fields over generic metadata."
    )
    content = _build_multimodal_content(prompt, image_paths)
    return _invoke_structured_llm(SCHEMA_RECOMMENDATION_PROMPT, content, _schema_recommendation_output_schema())


def _invoke_structured_llm(system_prompt: str, content: list[dict[str, Any]], output_schema: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    llm_kwargs: dict[str, Any] = {
        "model": settings.resolved_vlm_model_name,
        "api_key": settings.resolved_vlm_api_key,
        "temperature": settings.vlm_temperature,
        "timeout": settings.vlm_timeout_seconds,
        "max_retries": settings.vlm_max_retries,
    }
    if settings.vlm_base_url:
        llm_kwargs["base_url"] = settings.vlm_base_url

    llm = ChatOpenAI(**llm_kwargs)
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
            "key_name": {"type": "string", "description": "snake_case JSON key for the extracted value."},
            "description": {"type": "string", "description": "Field-level instruction for locating the value."},
            "output_format": {"type": "string", "enum": ["string", "float", "date", "bool"]},
        },
        "required": ["key_name", "description", "output_format"],
    }
    return {
        "title": "KIESchemaRecommendation",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "name": {"type": "string"},
            "display_name": {"type": "string"},
            "description": {"type": "string"},
            "fields": {"type": "array", "minItems": 1, "maxItems": 12, "items": field_schema},
        },
        "required": ["name", "display_name", "description", "fields"],
    }


def _build_user_prompt(fields: list[FieldDefinition]) -> str:
    lines = ["Extract these fields from the document images:"]
    for field in fields:
        lines.append(f"- {field.key_name} ({field.output_format}): {field.description}")
    lines.append("Return null for fields that are not visible.")
    return "\n".join(lines)


def _build_multimodal_content(prompt: str, image_paths: list[str]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for image_path in image_paths:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _image_to_data_url(Path(image_path))},
            }
        )
    return content


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
            "page": 1,
            "evidence": f"Mock evidence for {field.key_name}",
            "confidence": 0.86,
        }
    return values


def _mock_schema_recommendation() -> dict[str, Any]:
    return {
        "name": "ai_recommended_schema",
        "display_name": "AI Recommended Schema",
        "description": "Mock schema recommendation for local demo and UI testing.",
        "fields": [
            {
                "key_name": "document_number",
                "description": "Primary document, invoice, receipt, or application number visible near the top.",
                "output_format": "string",
            },
            {
                "key_name": "document_date",
                "description": "Main issued, submitted, or effective date printed on the document.",
                "output_format": "date",
            },
            {
                "key_name": "issuer_name",
                "description": "Organization, bank, vendor, or authority that issued the document.",
                "output_format": "string",
            },
            {
                "key_name": "recipient_name",
                "description": "Person or organization that the document is addressed to or belongs to.",
                "output_format": "string",
            },
            {
                "key_name": "total_amount",
                "description": "Final total, balance, transaction amount, or payment amount if one is visible.",
                "output_format": "float",
            },
        ],
    }
