from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


OutputFormat = Literal[
    "string",
    "float",
    "bool",
    "date",
]


class FieldDefinition(BaseModel):
    key_name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=1000)
    output_format: OutputFormat

    @field_validator("key_name")
    @classmethod
    def validate_key_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("key_name is required")
        return normalized

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return value.strip()


class SchemaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    description: str | None = None
    is_template: bool = False
    template_category: str | None = Field(default=None, max_length=120)
    pinned: bool = False
    fields: list[FieldDefinition] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_unique_fields(self) -> "SchemaCreate":
        keys = [field.key_name for field in self.fields]
        if len(keys) != len(set(keys)):
            raise ValueError("schema field key_name values must be unique")
        return self


class SchemaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    description: str | None = None
    is_template: bool | None = None
    template_category: str | None = Field(default=None, max_length=120)
    pinned: bool | None = None
    fields: list[FieldDefinition] | None = Field(default=None, min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else value

    @model_validator(mode="after")
    def validate_unique_fields(self) -> "SchemaUpdate":
        if self.fields is None:
            return self
        keys = [field.key_name for field in self.fields]
        if len(keys) != len(set(keys)):
            raise ValueError("schema field key_name values must be unique")
        return self


class SchemaRead(BaseModel):
    id: str
    name: str
    display_name: str | None
    description: str | None
    current_version: int
    is_template: bool
    template_category: str | None
    pinned: bool
    fields: list[FieldDefinition]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DocumentPageRead(BaseModel):
    id: str
    page: int
    image_url: str
    width: int
    height: int


class DocumentRead(BaseModel):
    document_id: str
    filename: str
    mime_type: str
    size_bytes: int
    page_count: int
    status: str
    document_type: str | None = None
    language: str | None = None
    ai_summary: str | None = None
    recommendation_reasoning: str | None = None
    pages: list[DocumentPageRead]
    created_at: datetime


class RawExtractionRead(BaseModel):
    id: str
    filename: str
    source_format: str
    size_bytes: int
    status: str
    pdf_url: str | None
    html_url: str | None
    warnings: list[str]
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class VlmSettingsRead(BaseModel):
    provider: str
    model_name: str | None
    has_api_key: bool
    env_path: str


class VlmSettingsUpdate(BaseModel):
    api_key: str | None = None
    model_name: str
    provider: str = "openai"


class SchemaRecommendationRequest(BaseModel):
    document_id: str


class SchemaRecommendationRead(BaseModel):
    name: str
    display_name: str | None = None
    description: str | None = None
    document_type: str | None = None
    language: str | None = None
    reasoning: str | None = None
    fields: list[FieldDefinition]


class ExtractionJobCreate(BaseModel):
    document_id: str
    schema_id: str
    schema_version: int | None = None
    options: dict[str, Any] = Field(default_factory=dict)


class ExtractionValue(BaseModel):
    value: Any
    normalized_value: Any = None
    page: int | None = None
    confidence: float | None = None
    evidence: str | None = None
    warnings: list[str] = Field(default_factory=list)


class ExtractionResultRead(BaseModel):
    id: str
    job_id: str
    raw_model_output: dict[str, Any]
    validated_output: dict[str, Any]
    corrected_output: dict[str, Any] | None
    validation_warnings: list[str]
    reviewed_fields: list[str]
    created_at: datetime
    updated_at: datetime


class ExtractionJobRead(BaseModel):
    job_id: str
    document_id: str
    schema_id: str
    schema_version: int
    status: str
    error_message: str | None
    result_id: str | None
    result: ExtractionResultRead | None = None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class ExtractionResultPatch(BaseModel):
    corrected_output: dict[str, Any] | None = None
    reviewed_fields: list[str] | None = None


class SystemStatusRead(BaseModel):
    app_env: str
    vlm_provider: str
    vlm_model_name: str | None
    has_vlm_credentials: bool
    is_mock: bool


class BatchItemRead(BaseModel):
    id: str
    document_id: str
    job_id: str
    filename: str
    status: str
    result_id: str | None = None
    error_message: str | None = None
    created_at: datetime


class BatchRead(BaseModel):
    id: str
    schema_id: str
    schema_version: int
    status: str
    total_count: int
    completed_count: int
    failed_count: int
    progress: float
    items: list[BatchItemRead]
    created_at: datetime
    completed_at: datetime | None


class ExportPresetField(BaseModel):
    key_name: str
    column_name: str | None = None
    include: bool = True


class ExportPresetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    schema_id: str | None = None
    fields: list[ExportPresetField] = Field(default_factory=list)


class ExportPresetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    schema_id: str | None = None
    fields: list[ExportPresetField] | None = None


class ExportPresetRead(BaseModel):
    id: str
    schema_id: str | None
    name: str
    fields: list[ExportPresetField]
    created_at: datetime
    updated_at: datetime


class ArchiveSearchResult(BaseModel):
    document_id: str
    filename: str
    document_type: str | None
    language: str | None
    job_id: str | None = None
    result_id: str | None = None
    schema_id: str | None = None
    schema_name: str | None = None
    status: str | None = None
    matched_text: str | None = None
    created_at: datetime


class AuditEventRead(BaseModel):
    id: str
    entity_type: str
    entity_id: str
    action: str
    message: str | None
    metadata: dict[str, Any]
    created_at: datetime
