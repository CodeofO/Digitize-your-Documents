from typing import Any

from app.prompts.structured_output import (
    required_field_checklist_recommendation_output_spec,
    schema_description_output_spec,
    schema_recommendation_output_spec,
)
from app.schemas import FieldDefinition


SCHEMA_RECOMMENDATION_PROMPT = """You are a document schema design assistant.
Look at the uploaded document images and recommend practical key information fields for extraction.
Return concise key names in the document's primary language.
For Korean documents, key_name values should be natural Korean labels such as 성명, 계급, 군번, 소집기간, 훈련장소.
For English documents, key_name values should be concise English snake_case labels.
Do not add a separate field display label; key_name is what users will see in the UI and exports.
Each field description must explain where or how to find the value in the document.
Use only these output formats: string, float, date, bool."""

SCHEMA_DESCRIPTION_PROMPT = """You are a document schema description editor.
Look only at the user's current extraction fields.
Write a concise schema-level description that explains what this schema extracts.
Do not invent fields. Do not rewrite field-level descriptions. Do not say it is an invoice unless the fields clearly indicate that.
Use the document's primary language. One or two sentences are enough."""

REQUIRED_FIELD_CHECKLIST_RECOMMENDATION_PROMPT = """You are a required field checklist design assistant.
Look at the uploaded document images and recommend practical presence-check items.
This is not a key-value extraction schema. Each item should ask whether required text, handwriting, signature, stamp, checkbox, or another visible mark exists.
Use the document's primary language for item_name and descriptions.
For Korean documents, item_name values should be natural Korean labels such as 성명, 작성일, 서명/날인, 동의 체크.
Recommend optional regions only when a repeated area is visually clear and likely useful."""


def build_schema_recommendation_prompt() -> str:
    return (
        "Recommend 5 to 8 fields that a user is likely to want from this document. "
        "Prefer visible business-critical fields over generic metadata. "
        "Choose key_name values in the document's primary language."
    )


def build_required_field_checklist_recommendation_prompt() -> str:
    return (
        "Recommend 4 to 8 checklist items that a user would verify before accepting this document. "
        "Prefer visible required fields and signatures over values that require external validation. "
        "Use concise item_name values in the document's primary language."
    )


def build_schema_description_prompt(
    schema_name: str,
    current_description: str | None,
    fields: list[FieldDefinition],
) -> str:
    lines = [
        f"Schema name: {schema_name}",
        f"Current schema description: {current_description or '(empty)'}",
        "Current fields:",
    ]
    for field in fields:
        region = f", region_id={field.region_id}" if field.region_id else ""
        lines.append(f"- {field.key_name} ({field.output_format}{region}): {field.description}")
    lines.append(
        "Return a schema description that matches only these fields. "
        "The description should help the user understand the extraction purpose at schema level."
    )
    return "\n".join(lines)


def build_schema_recommendation_output_schema() -> dict[str, Any]:
    return schema_recommendation_output_spec()


def build_schema_description_output_schema() -> dict[str, Any]:
    return schema_description_output_spec()


def build_required_field_checklist_recommendation_output_schema() -> dict[str, Any]:
    return required_field_checklist_recommendation_output_spec()
