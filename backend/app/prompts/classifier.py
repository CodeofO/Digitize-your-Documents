from typing import Any

from app.schemas import ClassCandidate


DOCUMENT_CLASSIFIER_PROMPT = """You are a document classification engine.
Choose only from the user-defined candidate classes.
If none of the classes fit, or the document is ambiguous, return status unknown with class_name null.
Use visual evidence and visible text only.
Return data that matches the requested structured output schema."""


def build_classification_prompt(classes: list[ClassCandidate], allow_unknown: bool) -> str:
    lines = [
        "Classify the document into one of these user-defined classes:",
    ]
    for item in classes:
        signals = ", ".join(item.signals) if item.signals else "(no explicit signals)"
        lines.append(f"- {item.class_name}: {item.description}. Signals: {signals}")
    lines.append("Return classified only when visible evidence supports one candidate class.")
    lines.append("Return unknown when no candidate class is clearly supported.")
    return "\n".join(lines)


def build_classification_output_schema(classes: list[ClassCandidate], allow_unknown: bool) -> dict[str, Any]:
    class_names = [item.class_name for item in classes]
    class_schema: dict[str, Any] = {"anyOf": [{"type": "string", "enum": class_names}, {"type": "null"}]}
    return {
        "title": "DocumentClassificationResult",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "status": {"type": "string", "enum": ["classified", "unknown"]},
            "class_name": class_schema,
            "confidence": {"anyOf": [{"type": "number", "minimum": 0, "maximum": 1}, {"type": "null"}]},
            "reason": {"type": "string"},
            "evidence": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["status", "class_name", "confidence", "reason", "evidence"],
    }

