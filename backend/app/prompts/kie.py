import json
from typing import Any

from app.prompts.structured_output import (
    kie_correction_output_spec,
    kie_extraction_output_spec,
    kie_judgement_output_spec,
)
from app.schemas import FieldDefinition


KIE_SYSTEM_PROMPT = """You are a key information extraction engine.
Extract only the fields defined by the schema.
Do not return keys that are not in the schema.
If a value is not visible or uncertain, return null.
Preserve the document's original wording when possible.
Return data that matches the requested structured output schema."""


def build_structured_output_schema(fields: list[FieldDefinition]) -> dict[str, Any]:
    return kie_extraction_output_spec(fields)


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
    return kie_judgement_output_spec()


def build_correction_output_schema(field: FieldDefinition) -> dict[str, Any]:
    return kie_correction_output_spec(field)


def build_judgement_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    if field.region_id or field.region is not None:
        return build_region_judgement_prompt(field, initial_value, initial_evidence)
    return build_full_page_judgement_prompt(field, initial_value, initial_evidence)


def build_full_page_judgement_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    return "\n".join(
        [
            "You are in the second-stage KIE judgement step.",
            "Decide whether the first-stage extraction for this field is already correct by looking at the full page image.",
            "This is a verification step, not a re-extraction step. Do not search for a better alternative value.",
            "The default decision is judgement_status=correct unless the image clearly contradicts the first-stage value.",
            "If handwriting is ambiguous, stylized, or could reasonably be read in multiple ways, keep the first-stage value and return correct.",
            "Be very conservative when judging placeholders or labels.",
            "Only treat text as a placeholder/label when it is printed form text and the actual input area has no handwritten value.",
            "If text such as 성명, 서명, 법정, or similar Korean words is handwritten inside the target input area, do not delete it as a placeholder.",
            "Do not extract a new value in this judgement step.",
            _field_review_context(field, initial_value, initial_evidence),
            "Return judgement_status=correct when the first-stage value matches the image.",
            "Return judgement_status=needs_correction only when there is high-confidence visual evidence that the first-stage value is wrong, incomplete, or unsupported.",
        ]
    )


def build_region_judgement_prompt(field: FieldDefinition, initial_value: Any, initial_evidence: str | None) -> str:
    return "\n".join(
        [
            "You are in the second-stage KIE judgement step for a field with a user-defined region.",
            "The crop image is already the target region selected from the original full page. Treat the crop as the primary evidence.",
            "Use the full page only to understand the crop's original page context.",
            "Do not reapply location words from the field description inside the crop coordinate system.",
            "This is a verification step, not a re-extraction step. Do not search for a better alternative value.",
            "The default decision is judgement_status=correct unless the crop clearly contradicts the first-stage value.",
            "If handwriting is ambiguous, stylized, or could reasonably be read in multiple ways, keep the first-stage value and return correct.",
            "Be very conservative when judging placeholders or labels.",
            "Only treat text as a placeholder/label when it is printed form text and the actual input area has no handwritten value.",
            "If text such as 성명, 서명, 법정, or similar Korean words is handwritten inside the target crop, do not delete it as a placeholder.",
            "Do not extract a new value in this judgement step.",
            _field_review_context(field, initial_value, initial_evidence),
            "Return judgement_status=correct when the first-stage value matches the crop evidence.",
            "Return judgement_status=needs_correction only when there is high-confidence crop evidence that the first-stage value is wrong, incomplete, or unsupported.",
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
            "Correct only this single field, and only when the visual evidence is explicit.",
            "Do not invent a new value. If the correction is uncertain, return the first-stage value unchanged.",
            "Do not change a non-empty handwritten Korean value to null merely because it looks like a label or placeholder.",
            "Return null only when the target input area is visibly empty or the first-stage value came from printed form text outside the user input area.",
            "Preserve the document's original wording and spacing when possible.",
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
            "Correct only this single field, and only when the crop evidence is explicit.",
            "Do not invent a new value. If the correction is uncertain, return the first-stage value unchanged.",
            "Do not change a non-empty handwritten Korean value to null merely because it looks like a label or placeholder.",
            "Return null only when the target crop is visibly empty or the first-stage value came from printed form text outside the user input area.",
            "Preserve the document's original wording and spacing when possible.",
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
