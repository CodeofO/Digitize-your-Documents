import json
from typing import Any

from app.prompts.common import json_schema_for_field
from app.schemas import FieldDefinition


KIE_SYSTEM_PROMPT = """You are a key information extraction engine.
Extract only the fields defined by the schema.
Do not return keys that are not in the schema.
If a value is not visible or uncertain, return null.
Preserve the document's original wording when possible.
Return data that matches the requested structured output schema."""


def build_structured_output_schema(fields: list[FieldDefinition]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in fields:
        properties[field.key_name] = json_schema_for_field(field)
        required.append(field.key_name)

    return {
        "title": "KeyInformationExtraction",
        "description": "Structured extraction result containing only user-defined schema fields.",
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": required,
    }


def build_extraction_prompt(fields: list[FieldDefinition]) -> str:
    if any(field.region_id or field.region is not None for field in fields):
        return build_region_extraction_prompt(fields)
    return build_full_page_extraction_prompt(fields)


def build_full_page_extraction_prompt(fields: list[FieldDefinition]) -> str:
    lines = ["Extract these fields from the full document page images:"]
    for field in fields:
        lines.append(f"- {field.key_name} ({field.output_format}): {field.description}.")
    lines.extend(
        [
            "Use the full page images as the only visual source for these fields.",
            "Return null for fields that are not visible.",
        ]
    )
    return "\n".join(lines)


def build_region_extraction_prompt(fields: list[FieldDefinition]) -> str:
    lines = ["Extract these fields from the labeled extraction region images:"]
    for field in fields:
        region_ref = field.region_id or "legacy field region"
        page_ref = f" on page {field.region.page}" if field.region else ""
        lines.append(
            f"- {field.key_name} ({field.output_format}): {field.description}. "
            f"Use the matching full page context, masked full page context, and enlarged crop for region '{region_ref}'{page_ref}."
        )
    lines.extend(
        [
            "For every region field, location words in the field description refer to the original full page position.",
            "The crop image is already the user-designated extraction region; do not reinterpret location words as crop-internal coordinates.",
            "Use the full page image only for document context, use the masked image to confirm the region's original position, and read the value from the matching crop.",
            "Do not use unrelated region crops for these fields.",
            "Return null for fields that are not visible.",
        ]
    )
    return "\n".join(lines)


def build_judgement_output_schema() -> dict[str, Any]:
    return {
        "title": "KIEFieldJudgement",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "judgement_status": {"type": "string", "enum": ["correct", "needs_correction"]},
            "reason": {"type": "string"},
            "confidence": {"anyOf": [{"type": "number", "minimum": 0, "maximum": 1}, {"type": "null"}]},
            "evidence": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        },
        "required": ["judgement_status", "reason", "confidence", "evidence"],
    }


def build_correction_output_schema(field: FieldDefinition) -> dict[str, Any]:
    field_schema = json_schema_for_field(field)
    properties = dict(field_schema["properties"])
    properties["correction_reason"] = {"type": "string"}
    return {
        "title": "KIEFieldCorrection",
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": ["value", "page", "evidence", "confidence", "correction_reason"],
    }


def build_judgement_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    if field.region_id or field.region is not None:
        return build_region_judgement_prompt(field, initial_value, initial_evidence)
    return build_full_page_judgement_prompt(field, initial_value, initial_evidence)


def build_full_page_judgement_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    return "\n".join(
        [
            "You are in the second-stage KIE judgement step.",
            "Decide whether the first-stage extraction for this field is already correct by looking at the full page image.",
            "Do not extract a new value in this judgement step.",
            _field_review_context(field, initial_value, initial_evidence),
            "Return judgement_status=correct when the first-stage value matches the image.",
            "Return judgement_status=needs_correction only when the image shows that the first-stage value is wrong, incomplete, or unsupported.",
        ]
    )


def build_region_judgement_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    return "\n".join(
        [
            "You are in the second-stage KIE judgement step for a field with a user-defined region.",
            "The crop image is already the target region selected from the original full page. Treat the crop as the primary evidence.",
            "Use the full page only to understand the crop's original page context.",
            "Do not reapply location words from the field description inside the crop coordinate system.",
            "Do not extract a new value in this judgement step.",
            _field_review_context(field, initial_value, initial_evidence),
            "Return judgement_status=correct when the first-stage value matches the crop evidence.",
            "Return judgement_status=needs_correction only when the crop evidence shows that the first-stage value is wrong, incomplete, or unsupported.",
        ]
    )


def build_correction_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None, judgement_reason: str | None) -> str:
    if field.region_id or field.region is not None:
        return build_region_correction_prompt(field, initial_value, initial_evidence, judgement_reason)
    return build_full_page_correction_prompt(field, initial_value, initial_evidence, judgement_reason)


def build_full_page_correction_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None, judgement_reason: str | None) -> str:
    return "\n".join(
        [
            "You are in the second-stage KIE correction step.",
            "A prior judgement step decided that the first-stage extraction needs correction.",
            "Extract the correct value for this single field from the full page image.",
            _field_review_context(field, initial_value, initial_evidence),
            f"Judgement reason: {judgement_reason or '(not provided)'}",
            "Return the corrected value, page, evidence, confidence, and correction_reason.",
        ]
    )


def build_region_correction_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None, judgement_reason: str | None) -> str:
    return "\n".join(
        [
            "You are in the second-stage KIE correction step for a field with a user-defined region.",
            "A prior judgement step decided that the first-stage extraction needs correction.",
            "The crop image is already the target region selected from the original full page. Treat the crop as the primary evidence.",
            "Use the full page only for original page context.",
            "Do not reapply location words from the field description inside the crop coordinate system.",
            _field_review_context(field, initial_value, initial_evidence),
            f"Judgement reason: {judgement_reason or '(not provided)'}",
            "Return the corrected value, page, evidence, confidence, and correction_reason.",
        ]
    )


def _field_review_context(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    return "\n".join(
        [
            f"key_name: {field.key_name}",
            f"description: {field.description}",
            f"output_format: {field.output_format}",
            f"first_stage_value: {_render_value(initial_value)}",
            f"first_stage_evidence: {initial_evidence or '(not provided)'}",
        ]
    )


def _render_value(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)

