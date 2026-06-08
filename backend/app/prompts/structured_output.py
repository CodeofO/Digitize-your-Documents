from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

from app.schemas import ClassCandidate, FieldDefinition, RequiredFieldItem


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


@dataclass(frozen=True)
class StructuredOutputSpec:
    title: str
    model: type[BaseModel]
    schema: dict[str, Any] | None = None

    def json_schema(self) -> dict[str, Any]:
        if self.schema is not None:
            return self.schema
        return self.model.model_json_schema(by_alias=True)


Confidence = float | None
NullablePage = int | None


class KieJudgementOutput(StrictBaseModel):
    judgement_status: Literal["correct", "needs_correction"]
    reason: str
    confidence: Confidence = Field(ge=0, le=1)
    evidence: str | None


class ClassificationOutput(StrictBaseModel):
    status: Literal["classified", "unknown"]
    class_name: str | None
    confidence: Confidence = Field(ge=0, le=1)
    reason: str
    evidence: list[str]


class SchemaFieldRecommendation(StrictBaseModel):
    key_name: str = Field(description="User-facing key for the extracted value, written in the document's primary language.")
    description: str = Field(description="Field-level instruction for locating the value.")
    output_format: Literal["string", "float", "date", "bool"]


class KeyInformationSchemaRecommendation(StrictBaseModel):
    name: str
    display_name: str
    description: str
    document_type: str
    language: str
    reasoning: str
    fields: list[SchemaFieldRecommendation] = Field(min_length=1, max_length=12)


class SchemaDescriptionRecommendation(StrictBaseModel):
    description: str = Field(description="Concise schema-level description aligned with the current fields.")
    reasoning: str = Field(description="Brief reason for the description update.")


class RecommendedRegion(StrictBaseModel):
    id: str
    name: str
    page: int = Field(ge=1)
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)


class RecommendedRequiredFieldItem(StrictBaseModel):
    item_name: str
    description: str
    evidence_type: Literal["text_or_handwriting", "checkbox", "signature_or_stamp", "visual_mark", "other"]
    required: bool
    region_id: str | None


class RequiredFieldChecklistRecommendation(StrictBaseModel):
    name: str
    description: str
    reasoning: str
    regions: list[RecommendedRegion] = Field(max_length=8)
    items: list[RecommendedRequiredFieldItem] = Field(min_length=1, max_length=12)


class RequiredFieldItemCheck(StrictBaseModel):
    status: Literal["present", "missing", "uncertain", "not_applicable"]
    confidence: Confidence = Field(ge=0, le=1)
    evidence: str | None
    page: NullablePage = Field(ge=1)


def kie_extraction_output_spec(fields: list[FieldDefinition]) -> StructuredOutputSpec:
    definitions: dict[str, tuple[Any, Any]] = {}
    for index, field in enumerate(fields, start=1):
        cell_model = create_model(
            _model_name("KieCell", [field.key_name, field.output_format]),
            value=(_value_type_for_output_format(field.output_format) | None, Field(...)),
            page=(NullablePage, Field(..., ge=1)),
            evidence=(str | None, Field(...)),
            confidence=(Confidence, Field(..., ge=0, le=1)),
            __base__=StrictBaseModel,
        )
        definitions[f"field_{index}"] = (cell_model, Field(..., alias=field.key_name, description=field.description))
    model = create_model("KeyInformationExtraction", **definitions, __base__=StrictBaseModel)
    return StructuredOutputSpec(title="KeyInformationExtraction", model=model)


def kie_judgement_output_spec() -> StructuredOutputSpec:
    return StructuredOutputSpec(title="KIEFieldJudgement", model=KieJudgementOutput)


def kie_correction_output_spec(field: FieldDefinition) -> StructuredOutputSpec:
    model = create_model(
        _model_name("KIEFieldCorrection", [field.key_name, field.output_format]),
        value=(_value_type_for_output_format(field.output_format) | None, Field(...)),
        page=(NullablePage, Field(..., ge=1)),
        evidence=(str | None, Field(...)),
        confidence=(Confidence, Field(..., ge=0, le=1)),
        correction_reason=(str, Field(...)),
        __base__=StrictBaseModel,
    )
    return StructuredOutputSpec(title="KIEFieldCorrection", model=model)


def classification_output_spec(classes: list[ClassCandidate], allow_unknown: bool) -> StructuredOutputSpec:
    class_names = [item.class_name for item in classes]
    class_type = _literal_from_values(class_names) if class_names else str
    model = create_model(
        "DocumentClassificationResult",
        status=(Literal["classified", "unknown"], Field(...)),
        class_name=(class_type | None, Field(...)),
        confidence=(Confidence, Field(..., ge=0, le=1)),
        reason=(str, Field(...)),
        evidence=(list[str], Field(...)),
        __base__=StrictBaseModel,
    )
    return StructuredOutputSpec(title="DocumentClassificationResult", model=model)


def required_field_output_spec(items: list[RequiredFieldItem]) -> StructuredOutputSpec:
    item_fields: dict[str, tuple[Any, Any]] = {}
    for index, item in enumerate(items, start=1):
        item_fields[f"item_{index}"] = (
            RequiredFieldItemCheck,
            Field(..., alias=item.item_name, description=item.description),
        )
    items_model = create_model(_model_name("RequiredFieldItems", [item.item_name for item in items]), **item_fields, __base__=StrictBaseModel)
    model = create_model(
        "RequiredFieldCheckResult",
        overall_status=(Literal["complete", "incomplete", "needs_review"], Field(...)),
        items=(items_model, Field(...)),
        __base__=StrictBaseModel,
    )
    return StructuredOutputSpec(title="RequiredFieldCheckResult", model=model)


def schema_recommendation_output_spec() -> StructuredOutputSpec:
    return StructuredOutputSpec(title="KeyInformationSchemaRecommendation", model=KeyInformationSchemaRecommendation)


def schema_description_output_spec() -> StructuredOutputSpec:
    return StructuredOutputSpec(title="KeyInformationSchemaDescriptionRecommendation", model=SchemaDescriptionRecommendation)


def required_field_checklist_recommendation_output_spec() -> StructuredOutputSpec:
    return StructuredOutputSpec(title="RequiredFieldChecklistRecommendation", model=RequiredFieldChecklistRecommendation)


def _value_type_for_output_format(output_format: str) -> type[str] | type[float] | type[bool]:
    if output_format == "float":
        return float
    if output_format == "bool":
        return bool
    return str


def _literal_from_values(values: list[str]) -> Any:
    return Literal.__getitem__(tuple(values))


def _model_name(prefix: str, parts: list[str]) -> str:
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]
    return f"{prefix}_{digest}"
