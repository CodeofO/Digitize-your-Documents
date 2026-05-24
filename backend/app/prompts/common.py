from typing import Any

from app.schemas import FieldDefinition


def image_inputs_from_paths(image_paths: list[str]) -> list[dict[str, str]]:
    return [{"path": image_path, "label": f"Full document page {index + 1}"} for index, image_path in enumerate(image_paths)]


def json_schema_for_field(field: FieldDefinition) -> dict[str, Any]:
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

