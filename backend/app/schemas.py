from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


OutputFormat = Literal[
    "string",
    "float",
    "bool",
    "date",
]


class FieldRegion(BaseModel):
    page: int = Field(ge=1)
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def validate_bounds(self) -> "FieldRegion":
        if self.x + self.width > 1:
            raise ValueError("region x + width must be less than or equal to 1")
        if self.y + self.height > 1:
            raise ValueError("region y + height must be less than or equal to 1")
        return self


class FieldDefinition(BaseModel):
    key_name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=1000)
    output_format: OutputFormat
    region_id: str | None = Field(default=None, max_length=80)
    region: FieldRegion | None = None
    judgement_enabled: bool = False

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

    @field_validator("region_id")
    @classmethod
    def validate_region_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class SchemaRegion(FieldRegion):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)

    @field_validator("id", "name")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return value.strip()


class SchemaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    description: str | None = None
    is_template: bool = False
    template_category: str | None = Field(default=None, max_length=120)
    pinned: bool = False
    regions: list[SchemaRegion] = Field(default_factory=list)
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
        region_ids = [region.id for region in self.regions]
        if len(region_ids) != len(set(region_ids)):
            raise ValueError("schema region ids must be unique")
        missing_region_ids = sorted(
            {
                field.region_id
                for field in self.fields
                if field.region_id and field.region_id not in set(region_ids)
            }
        )
        if missing_region_ids:
            raise ValueError(f"schema field region_id values are missing from regions: {', '.join(missing_region_ids)}")
        return self


class SchemaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    description: str | None = None
    is_template: bool | None = None
    template_category: str | None = Field(default=None, max_length=120)
    pinned: bool | None = None
    regions: list[SchemaRegion] | None = None
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
        if self.regions is not None:
            region_ids = [region.id for region in self.regions]
            if len(region_ids) != len(set(region_ids)):
                raise ValueError("schema region ids must be unique")
            missing_region_ids = sorted(
                {
                    field.region_id
                    for field in self.fields
                    if field.region_id and field.region_id not in set(region_ids)
                }
            )
            if missing_region_ids:
                raise ValueError(f"schema field region_id values are missing from regions: {', '.join(missing_region_ids)}")
        return self


class SchemaRead(BaseModel):
    id: str
    name: str
    display_name: str | None
    description: str | None
    is_template: bool
    template_category: str | None
    pinned: bool
    ephemeral: bool = False
    archived: bool = False
    regions: list[SchemaRegion]
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
    library_path: str | None = None
    mime_type: str
    size_bytes: int
    page_count: int
    status: str
    error_message: str | None = None
    document_type: str | None = None
    language: str | None = None
    ai_summary: str | None = None
    recommendation_reasoning: str | None = None
    pages: list[DocumentPageRead]
    created_at: datetime
    deleted_at: datetime | None = None


class DocumentBatchUploadRead(BaseModel):
    documents: list[DocumentRead]


class DocumentTreeFolderRead(BaseModel):
    path: str
    name: str
    parent: str | None = None
    total_count: int = 0
    ready_count: int = 0
    converting_count: int = 0
    failed_count: int = 0
    deleted_count: int = 0


class DocumentTreeRead(BaseModel):
    folders: list[DocumentTreeFolderRead]


class DocumentLibraryCreateFolderRequest(BaseModel):
    folder_path: str = Field(min_length=1, max_length=1000)


class DocumentLibraryClipboardRequest(BaseModel):
    document_ids: list[str] = Field(default_factory=list, max_length=10000)
    folder_paths: list[str] = Field(default_factory=list, max_length=1000)
    target_folder: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def validate_targets(self) -> "DocumentLibraryClipboardRequest":
        if not self.document_ids and not self.folder_paths:
            raise ValueError("document_ids or folder_paths is required")
        return self


class DocumentLibraryActionRead(BaseModel):
    documents: list[DocumentRead] = Field(default_factory=list)
    folders: list[DocumentTreeFolderRead] = Field(default_factory=list)


class DocumentSelectionRequest(BaseModel):
    document_ids: list[str] = Field(min_length=1, max_length=10000)


class BatchFromDocumentsRequest(DocumentSelectionRequest):
    schema_id: str


class ClassificationBatchFromDocumentsRequest(DocumentSelectionRequest):
    classifier_id: str


class RequiredFieldCheckBatchFromDocumentsRequest(DocumentSelectionRequest):
    checklist_id: str


class WorkflowRunFromDocumentsRequest(DocumentSelectionRequest):
    pass


class RawExtractionFromDocumentRequest(BaseModel):
    document_id: str
    include_images: bool = True
    include_formulas: bool = False


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
    base_url: str | None
    libreoffice_path: str | None
    inference_params: dict[str, str]
    reasoning_effort: str | None
    verbosity: str | None
    temperature: str | None
    max_completion_tokens: str | None
    top_p: str | None
    service_tier: str | None
    workflow_max_workers: int
    vlm_max_concurrent_requests: int
    vlm_timeout_seconds: int
    kie_field_group_size: int
    has_api_key: bool
    env_path: str
    runtime_settings_writable: bool


class VlmSettingsUpdate(BaseModel):
    api_key: str | None = None
    model_name: str
    base_url: str | None = None
    libreoffice_path: str | None = None
    provider: str = "auto"
    inference_params: dict[str, Any] | None = None
    reasoning_effort: str | None = None
    verbosity: str | None = None
    temperature: str | None = None
    max_completion_tokens: str | None = None
    top_p: str | None = None
    service_tier: str | None = None
    workflow_max_workers: int | None = Field(default=None, ge=1, le=128)
    vlm_max_concurrent_requests: int | None = Field(default=None, ge=1, le=512)
    vlm_timeout_seconds: int | None = Field(default=None, ge=1, le=7200)
    kie_field_group_size: int | None = Field(default=None, ge=1, le=20)


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


class SchemaDescriptionRecommendationRequest(BaseModel):
    document_id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    current_description: str | None = None
    regions: list[SchemaRegion] = Field(default_factory=list)
    fields: list[FieldDefinition] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_unique_fields(self) -> "SchemaDescriptionRecommendationRequest":
        keys = [field.key_name for field in self.fields]
        if len(keys) != len(set(keys)):
            raise ValueError("schema field key_name values must be unique")
        region_ids = [region.id for region in self.regions]
        missing_region_ids = sorted(
            {
                field.region_id
                for field in self.fields
                if field.region_id and field.region_id not in set(region_ids)
            }
        )
        if missing_region_ids:
            raise ValueError(f"schema field region_id values are missing from regions: {', '.join(missing_region_ids)}")
        return self


class SchemaDescriptionRecommendationRead(BaseModel):
    description: str
    reasoning: str | None = None


ClassificationStatus = Literal["classified", "unknown"]
RequiredFieldEvidenceType = str
RequiredFieldItemStatus = Literal["present", "missing", "uncertain", "not_applicable"]
RequiredFieldOverallStatus = Literal["complete", "incomplete", "needs_review"]


class ClassCandidate(BaseModel):
    class_name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    signals: list[str] = Field(default_factory=list)

    @field_validator("class_name", "description")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("signals")
    @classmethod
    def validate_signals(cls, values: list[str]) -> list[str]:
        return [value.strip() for value in values if value.strip()]


class DocumentClassifierCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    allow_unknown: bool = True
    classes: list[ClassCandidate] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_unique_classes(self) -> "DocumentClassifierCreate":
        names = [item.class_name for item in self.classes]
        if len(names) != len(set(names)):
            raise ValueError("classifier class_name values must be unique")
        return self


class DocumentClassifierUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    allow_unknown: bool | None = None
    classes: list[ClassCandidate] | None = Field(default=None, min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else value

    @model_validator(mode="after")
    def validate_unique_classes(self) -> "DocumentClassifierUpdate":
        if self.classes is None:
            return self
        names = [item.class_name for item in self.classes]
        if len(names) != len(set(names)):
            raise ValueError("classifier class_name values must be unique")
        return self


class DocumentClassifierRead(BaseModel):
    id: str
    name: str
    description: str | None
    allow_unknown: bool
    archived: bool = False
    classes: list[ClassCandidate]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ClassificationJobCreate(BaseModel):
    document_id: str
    classifier_id: str


class ClassificationResultRead(BaseModel):
    id: str
    job_id: str
    raw_model_output: dict[str, Any]
    validated_output: dict[str, Any]
    corrected_output: dict[str, Any] | None
    reviewed: bool
    created_at: datetime
    updated_at: datetime


class ClassificationJobRead(BaseModel):
    job_id: str
    document_id: str
    classifier_id: str
    status: str
    error_message: str | None
    result_id: str | None
    result: ClassificationResultRead | None = None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class ClassificationResultPatch(BaseModel):
    corrected_output: dict[str, Any] | None = None
    reviewed: bool | None = None


class ClassificationBatchItemRead(BaseModel):
    id: str
    document_id: str
    job_id: str
    filename: str
    upload_index: int | None = None
    status: str
    result_id: str | None = None
    error_message: str | None = None
    created_at: datetime


class ClassificationBatchRead(BaseModel):
    id: str
    classifier_id: str
    status: str
    total_count: int
    completed_count: int
    failed_count: int
    canceled_count: int
    uploaded_count: int = 0
    preprocessing_count: int = 0
    ready_count: int = 0
    queued_count: int = 0
    running_count: int = 0
    needs_review_count: int = 0
    progress_phase: str = "queued"
    progress: float
    items: list[ClassificationBatchItemRead]
    created_at: datetime
    completed_at: datetime | None


class RequiredFieldItem(BaseModel):
    item_name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    evidence_type: RequiredFieldEvidenceType = Field(default="text_or_handwriting", min_length=1, max_length=120)
    required: bool = True
    region_id: str | None = Field(default=None, max_length=80)

    @field_validator("item_name", "description", "evidence_type")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("region_id")
    @classmethod
    def validate_region_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class RequiredFieldChecklistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    regions: list[SchemaRegion] = Field(default_factory=list)
    items: list[RequiredFieldItem] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_items_and_regions(self) -> "RequiredFieldChecklistCreate":
        _validate_required_checklist(self.items, self.regions)
        return self


class RequiredFieldChecklistUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    regions: list[SchemaRegion] | None = None
    items: list[RequiredFieldItem] | None = Field(default=None, min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else value

    @model_validator(mode="after")
    def validate_items_and_regions(self) -> "RequiredFieldChecklistUpdate":
        if self.items is not None and self.regions is not None:
            _validate_required_checklist(self.items, self.regions)
        elif self.items is not None:
            names = [item.item_name for item in self.items]
            if len(names) != len(set(names)):
                raise ValueError("required field item_name values must be unique")
        elif self.regions is not None:
            region_ids = [region.id for region in self.regions]
            if len(region_ids) != len(set(region_ids)):
                raise ValueError("required field region ids must be unique")
        return self


class RequiredFieldChecklistRead(BaseModel):
    id: str
    name: str
    description: str | None
    archived: bool = False
    regions: list[SchemaRegion]
    items: list[RequiredFieldItem]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RequiredFieldChecklistRecommendationRequest(BaseModel):
    document_id: str


class RequiredFieldChecklistRecommendationRead(BaseModel):
    name: str
    description: str | None = None
    reasoning: str | None = None
    regions: list[SchemaRegion] = Field(default_factory=list)
    items: list[RequiredFieldItem] = Field(min_length=1)


class RequiredFieldCheckJobCreate(BaseModel):
    document_id: str
    checklist_id: str


class RequiredFieldCheckResultRead(BaseModel):
    id: str
    job_id: str
    raw_model_output: dict[str, Any]
    validated_output: dict[str, Any]
    corrected_output: dict[str, Any] | None
    reviewed: bool
    created_at: datetime
    updated_at: datetime


class RequiredFieldCheckJobRead(BaseModel):
    job_id: str
    document_id: str
    checklist_id: str
    status: str
    error_message: str | None
    result_id: str | None
    result: RequiredFieldCheckResultRead | None = None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class RequiredFieldCheckResultPatch(BaseModel):
    corrected_output: dict[str, Any] | None = None
    reviewed: bool | None = None


class RequiredFieldCheckBatchItemRead(BaseModel):
    id: str
    document_id: str
    job_id: str
    filename: str
    upload_index: int | None = None
    status: str
    result_id: str | None = None
    error_message: str | None = None
    created_at: datetime


class RequiredFieldCheckBatchRead(BaseModel):
    id: str
    checklist_id: str
    status: str
    total_count: int
    completed_count: int
    failed_count: int
    canceled_count: int
    uploaded_count: int = 0
    preprocessing_count: int = 0
    ready_count: int = 0
    queued_count: int = 0
    running_count: int = 0
    needs_review_count: int = 0
    progress_phase: str = "queued"
    progress: float
    items: list[RequiredFieldCheckBatchItemRead]
    created_at: datetime
    completed_at: datetime | None


def _validate_required_checklist(items: list[RequiredFieldItem], regions: list[SchemaRegion]) -> None:
    names = [item.item_name for item in items]
    if len(names) != len(set(names)):
        raise ValueError("required field item_name values must be unique")
    region_ids = [region.id for region in regions]
    if len(region_ids) != len(set(region_ids)):
        raise ValueError("required field region ids must be unique")
    region_id_set = set(region_ids)
    missing_region_ids = sorted({item.region_id for item in items if item.region_id and item.region_id not in region_id_set})
    if missing_region_ids:
        raise ValueError(f"required field item region_id values are missing from regions: {', '.join(missing_region_ids)}")


class ExtractionJobCreate(BaseModel):
    document_id: str
    schema_id: str
    options: dict[str, Any] = Field(default_factory=dict)


class DraftExtractionJobCreate(BaseModel):
    document_id: str
    schema_definition: SchemaCreate = Field(alias="schema")
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
    upload_max_batch_files: int
    upload_chunk_files: int
    preprocess_max_workers: int
    workflow_max_workers: int
    vlm_max_concurrent_requests: int
    document_page_max_long_edge: int
    document_page_jpeg_quality: int


class UploadOwnerCounters(BaseModel):
    uploaded_count: int = 0
    preprocessing_count: int = 0
    ready_count: int = 0
    queued_count: int = 0
    running_count: int = 0
    completed_count: int = 0
    failed_count: int = 0
    canceled_count: int = 0
    needs_review_count: int = 0
    progress_phase: str = "queued"


class BatchInitRequest(BaseModel):
    schema_id: str
    total_count: int = Field(ge=1)


class ClassificationBatchInitRequest(BaseModel):
    classifier_id: str
    total_count: int = Field(ge=1)


class RequiredFieldCheckBatchInitRequest(BaseModel):
    checklist_id: str
    total_count: int = Field(ge=1)


class BatchItemRead(BaseModel):
    id: str
    document_id: str
    job_id: str
    filename: str
    upload_index: int | None = None
    status: str
    result_id: str | None = None
    error_message: str | None = None
    created_at: datetime


class BatchRead(BaseModel):
    id: str
    schema_id: str
    status: str
    total_count: int
    completed_count: int
    failed_count: int
    canceled_count: int
    uploaded_count: int = 0
    preprocessing_count: int = 0
    ready_count: int = 0
    queued_count: int = 0
    running_count: int = 0
    needs_review_count: int = 0
    progress_phase: str = "queued"
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


ExportJobOwnerType = Literal["workflow_run", "batch", "classification_batch", "required_field_check_batch"]
ExportJobFormat = Literal["json", "csv", "xlsx"]


class ExportJobCreate(BaseModel):
    owner_type: ExportJobOwnerType
    owner_id: str = Field(min_length=1)
    format: ExportJobFormat = "csv"


class ExportJobRead(BaseModel):
    id: str
    owner_type: str
    owner_id: str
    format: str
    status: str
    filename: str | None = None
    content_type: str | None = None
    size_bytes: int = 0
    error_message: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None


class WorkflowDefinitionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    definition: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()


class WorkflowDefinitionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    definition: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else value


class WorkflowAiDraftRead(BaseModel):
    workflow_name: str
    schema_draft: SchemaCreate
    checklist_draft: RequiredFieldChecklistCreate | None = None
    definition: dict[str, Any]
    sample_count: int
    images_persisted: bool = False
    reasoning: str | None = None


class WorkflowDefinitionRead(BaseModel):
    id: str
    name: str
    description: str | None
    definition: dict[str, Any]
    archived: bool = False
    validation_warnings: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class WorkflowRunItemRead(BaseModel):
    id: str
    run_id: str
    document_id: str
    filename: str
    upload_index: int | None = None
    status: str
    error_message: str | None = None
    upload_duration_ms: int | None = None
    inference_duration_ms: int | None = None
    result: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    completed_at: datetime | None


class WorkflowRunRead(BaseModel):
    id: str
    workflow_id: str
    workflow_name: str | None = None
    restarted_from_run_id: str | None = None
    workflow_run_group_id: str | None = None
    queued_from_run_id: str | None = None
    queue_order: int | None = None
    status: str
    total_count: int
    completed_count: int
    failed_count: int
    needs_review_count: int
    uploaded_count: int = 0
    preprocessing_count: int = 0
    ready_count: int = 0
    queued_count: int = 0
    running_count: int = 0
    canceled_count: int = 0
    vlm_active_count: int = 0
    vlm_waiting_count: int = 0
    vlm_limit: int = 0
    progress_phase: str = "queued"
    progress: float
    error_message: str | None = None
    upload_duration_ms: int | None = None
    inference_duration_ms: int | None = None
    items: list[WorkflowRunItemRead]
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None


class WorkflowRunInitRequest(BaseModel):
    total_count: int = Field(ge=1)


class WorkflowRunRestartRequest(BaseModel):
    workflow_id: str | None = None


class WorkflowRunEnqueueRequest(BaseModel):
    workflow_id: str | None = None


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
