from typing import Any

from app.prompts.structured_output import classification_output_spec
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
    return classification_output_spec(classes, allow_unknown)
