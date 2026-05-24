from typing import Any

from app.schemas import RequiredFieldItem, SchemaRegion


REQUIRED_FIELD_CHECKER_PROMPT = """You are a required field presence checker.
Check whether each user-defined item is visibly present, missing, uncertain, or not applicable.
Do not validate whether a value is correct. Only decide whether the required mark, handwriting, text, signature, stamp, checkbox, or visual evidence exists.
Use optional region crops only for their matching items.
Return data that matches the requested structured output schema."""


def build_required_field_prompt(items: list[RequiredFieldItem], regions: list[SchemaRegion]) -> str:
    if any(item.region_id for item in items):
        return build_region_required_field_prompt(items, regions)
    return build_full_page_required_field_prompt(items)


def build_full_page_required_field_prompt(items: list[RequiredFieldItem]) -> str:
    lines = ["Check whether these required field items are visibly present in the full document pages:"]
    for item in items:
        required_text = "required" if item.required else "optional"
        lines.append(f"- {item.item_name} ({item.evidence_type}, {required_text}): {item.description}")
    lines.append(
        "Only judge presence. Do not validate date validity, amount correctness, ID format, external database match, or signer identity."
    )
    return "\n".join(lines)


def build_region_required_field_prompt(items: list[RequiredFieldItem], regions: list[SchemaRegion]) -> str:
    region_names = {region.id: region.name for region in regions}
    lines = ["Check whether these required field items are visibly present in their labeled region images:"]
    for item in items:
        required_text = "required" if item.required else "optional"
        region_text = f"region_id={item.region_id} ({region_names.get(item.region_id, 'unknown region')})"
        lines.append(f"- {item.item_name} ({item.evidence_type}, {required_text}, {region_text}): {item.description}")
    lines.extend(
        [
            "Use the masked page context to understand each region's original page position.",
            "Use the matching crop as the primary visual evidence for the listed items.",
            "Only judge presence. Do not validate date validity, amount correctness, ID format, external database match, or signer identity.",
        ]
    )
    return "\n".join(lines)


def build_required_field_output_schema(items: list[RequiredFieldItem]) -> dict[str, Any]:
    return {
        "title": "RequiredFieldCheckResult",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "overall_status": {"type": "string", "enum": ["complete", "incomplete", "needs_review"]},
            "items": {
                "type": "array",
                "minItems": len(items),
                "maxItems": len(items),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "item_name": {"type": "string", "enum": [item.item_name for item in items]},
                        "status": {"type": "string", "enum": ["present", "missing", "uncertain", "not_applicable"]},
                        "confidence": {"anyOf": [{"type": "number", "minimum": 0, "maximum": 1}, {"type": "null"}]},
                        "evidence": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                        "page": {"anyOf": [{"type": "integer", "minimum": 1}, {"type": "null"}]},
                    },
                    "required": ["item_name", "status", "confidence", "evidence", "page"],
                },
            },
        },
        "required": ["overall_status", "items"],
    }


def full_page_required_label(page_number: int) -> str:
    return f"Full document page {page_number} for required field checking."


def masked_required_region_label(region: SchemaRegion, item_names: list[str]) -> str:
    return f"Masked context for required field region '{region.name}' on page {region.page}. Use for: {', '.join(item_names)}."


def cropped_required_region_label(region: SchemaRegion, item_names: list[str]) -> str:
    return f"Cropped required field region '{region.name}' on page {region.page}. Use as primary visual evidence for: {', '.join(item_names)}."

