import re
from datetime import datetime
from typing import Any

from app.domain.schema_definition import FieldDefinitionValue
from app.schemas import FieldDefinition


LOW_CONFIDENCE_THRESHOLD = 0.75


def validate_extracted_values(
    raw_values: dict[str, Any],
    fields: list[FieldDefinition],
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    domain_fields = [FieldDefinitionValue.from_dto(field) for field in fields]
    field_map = {field.key_name: field for field in domain_fields}
    values: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []

    unknown_keys = sorted(set(raw_values) - set(field_map))
    for key in unknown_keys:
        warnings.append(f"Unexpected key ignored: {key}")

    for field in domain_fields:
        field_warnings: list[str] = []
        raw_item = raw_values.get(field.key_name)
        if field.key_name not in raw_values:
            field_warnings.append("missing")

        value, page, confidence, evidence, metadata_warnings = _unpack_extraction_item(raw_item)
        field_warnings.extend(metadata_warnings)
        if _is_empty_value(value) and evidence is None:
            field_warnings.append("not_detected")
            if confidence == 0:
                confidence = None
        elif confidence is not None and confidence < LOW_CONFIDENCE_THRESHOLD:
            field_warnings.append("low_confidence")
        normalized_value, normalization_warnings = _normalize_value(value, field.output_format)
        field_warnings.extend(normalization_warnings)

        if value is not None and not _matches_format(normalized_value, field.output_format):
            field_warnings.append(f"invalid_type:{field.output_format}")

        values[field.key_name] = {
            "value": value,
            "normalized_value": normalized_value,
            "page": page,
            "confidence": confidence,
            "evidence": evidence,
            "warnings": field_warnings,
        }
        warnings.extend(f"{field.key_name}:{warning}" for warning in field_warnings)

    return values, warnings


def _matches_format(value: Any, output_format: str) -> bool:
    if value is None:
        return True
    if output_format in {"string", "date"}:
        return isinstance(value, str)
    if output_format == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if output_format == "bool":
        return isinstance(value, bool)
    return False


def _is_empty_value(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _unpack_extraction_item(raw_item: Any) -> tuple[Any, int | None, float | None, str | None, list[str]]:
    if not isinstance(raw_item, dict):
        return raw_item, None, None, None, []

    warnings: list[str] = []
    value = raw_item.get("value")
    page = raw_item.get("page")
    confidence = raw_item.get("confidence")
    evidence = raw_item.get("evidence")

    normalized_page: int | None = None
    if page is not None:
        if isinstance(page, int) and page > 0:
            normalized_page = page
        else:
            warnings.append("invalid_page")

    normalized_confidence: float | None = None
    if confidence is not None:
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and 0 <= confidence <= 1:
            normalized_confidence = float(confidence)
        else:
            warnings.append("invalid_confidence")

    normalized_evidence = evidence.strip() if isinstance(evidence, str) and evidence.strip() else None
    return value, normalized_page, normalized_confidence, normalized_evidence, warnings


def _normalize_value(value: Any, output_format: str) -> tuple[Any, list[str]]:
    if value is None:
        return None, []
    if output_format == "string" and isinstance(value, str):
        return value.strip(), []
    if output_format == "date" and isinstance(value, str):
        return _normalize_date(value)
    if output_format == "float":
        return _normalize_float(value)
    if output_format == "bool":
        return _normalize_bool(value)
    return value, []


def _normalize_float(value: Any) -> tuple[Any, list[str]]:
    if isinstance(value, bool):
        return value, []
    if isinstance(value, int):
        return float(value), []
    if isinstance(value, float):
        return value, []
    if not isinstance(value, str):
        return value, []

    cleaned = value.strip()
    cleaned = re.sub(r"[$€£₩¥,\s]", "", cleaned)
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = f"-{cleaned[1:-1]}"
    try:
        return float(cleaned), []
    except ValueError:
        return value, []


def _normalize_bool(value: Any) -> tuple[Any, list[str]]:
    if isinstance(value, bool):
        return value, []
    if not isinstance(value, str):
        return value, []
    normalized = value.strip().lower()
    truthy = {"true", "yes", "y", "1", "예", "네", "동의", "있음", "유"}
    falsy = {"false", "no", "n", "0", "아니오", "아니요", "미동의", "없음", "무"}
    if normalized in truthy:
        return True, []
    if normalized in falsy:
        return False, []
    return value, []


def _normalize_date(value: str) -> tuple[str, list[str]]:
    stripped = value.strip()
    candidates = [
        ("%Y-%m-%d", stripped),
        ("%Y.%m.%d", stripped),
        ("%Y/%m/%d", stripped),
    ]
    korean_match = re.fullmatch(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", stripped)
    if korean_match:
        year, month, day = korean_match.groups()
        candidates.append(("%Y-%m-%d", f"{year}-{int(month):02d}-{int(day):02d}"))

    for date_format, candidate in candidates:
        try:
            return datetime.strptime(candidate, date_format).date().isoformat(), []
        except ValueError:
            continue
    return stripped, ["invalid_date"]
