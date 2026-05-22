import csv
import io
import json
import shutil
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.audit import log_audit_event
from app.auth import (
    authenticate_access_code,
    clear_session,
    create_session,
    is_public_api_path,
    read_session,
    require_session_for_request,
)
from app.config import DEFAULT_LIBREOFFICE_PATH, ROOT_ENV_PATH, get_settings, parse_cors_allowed_origins, resolved_cors_allow_origin_regex, upsert_root_env
from app.database import SessionLocal, get_db, init_db
from app.document_processor import (
    DocumentProcessingError,
    is_supported_image,
    rasterize_document,
    rasterize_image_page,
    read_image_size,
    save_upload_file,
)
from app.document_modules import (
    classification_result_to_dict,
    required_field_result_to_dict,
    run_classification_batch,
    run_classification_job,
    run_required_field_check_batch,
    run_required_field_check_job,
)
from app.extraction import result_to_dict, run_batch_jobs, run_extraction_job
from app.models import (
    AuditEvent,
    Batch,
    BatchItem,
    ClassificationBatch,
    ClassificationBatchItem,
    ClassificationJob,
    ClassificationResult,
    Document,
    DocumentClassifier,
    DocumentPage,
    ExportPreset,
    ExtractionJob,
    ExtractionResult,
    RawExtraction,
    RequiredFieldCheckBatch,
    RequiredFieldCheckBatchItem,
    RequiredFieldCheckJob,
    RequiredFieldCheckResult,
    RequiredFieldChecklist,
    Schema,
    WorkflowDefinition,
    WorkflowRun,
    WorkflowRunItem,
)
from app.raw_extractor import RawExtractionError, RawExtractionOptions, create_raw_outputs, save_raw_upload, validate_raw_upload
from app.schemas import (
    ArchiveSearchResult,
    AuditEventRead,
    BatchItemRead,
    BatchRead,
    ClassificationBatchItemRead,
    ClassificationBatchRead,
    ClassificationJobCreate,
    ClassificationJobRead,
    ClassificationResultPatch,
    ClassificationResultRead,
    DocumentPageRead,
    DocumentRead,
    DocumentClassifierCreate,
    DocumentClassifierRead,
    DocumentClassifierUpdate,
    DraftExtractionJobCreate,
    ExportPresetCreate,
    ExportPresetRead,
    ExportPresetUpdate,
    ExtractionJobCreate,
    ExtractionJobRead,
    ExtractionResultPatch,
    RawExtractionRead,
    RequiredFieldCheckBatchItemRead,
    RequiredFieldCheckBatchRead,
    RequiredFieldCheckJobCreate,
    RequiredFieldCheckJobRead,
    RequiredFieldCheckResultPatch,
    RequiredFieldCheckResultRead,
    RequiredFieldChecklistCreate,
    RequiredFieldChecklistRecommendationRead,
    RequiredFieldChecklistRecommendationRequest,
    RequiredFieldChecklistRead,
    RequiredFieldChecklistUpdate,
    SchemaCreate,
    SchemaDescriptionRecommendationRead,
    SchemaDescriptionRecommendationRequest,
    SchemaRecommendationRead,
    SchemaRecommendationRequest,
    SchemaRead,
    SchemaUpdate,
    SystemStatusRead,
    VlmSettingsRead,
    VlmSettingsUpdate,
    WorkflowDefinitionCreate,
    WorkflowDefinitionRead,
    WorkflowDefinitionUpdate,
    WorkflowRunRead,
)
from app.vlm import (
    recommend_required_field_checklist_with_vlm,
    recommend_schema_description_with_vlm,
    recommend_schema_with_vlm,
    resolve_vlm_api_style,
    vlm_error_detail,
)
from app.workflows import (
    WorkflowDefinitionError,
    run_workflow_run,
    validate_workflow_definition,
    workflow_definition_to_read,
    workflow_run_export_csv,
    workflow_run_export_payload,
    workflow_run_to_read,
)
from app.storage import delete_local_tree, delete_storage_ref, is_s3_ref, materialize_storage_ref, persist_artifact, scratch_dir_for_ref


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    stop_cleanup = _start_retention_cleanup_worker()
    yield
    if stop_cleanup:
        stop_cleanup.set()


app = FastAPI(title="Document Automation Workspace API", version="0.1.0", lifespan=lifespan)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_cors_allowed_origins(settings.cors_allowed_origins),
    allow_origin_regex=resolved_cors_allow_origin_regex(settings.cors_allow_origin_regex),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_and_security_middleware(request: Request, call_next):
    settings = get_settings()
    try:
        if request.url.path.startswith("/api/") and request.method.upper() != "OPTIONS" and not is_public_api_path(request.url.path):
            require_session_for_request(request, settings)
    except HTTPException as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    response = await call_next(request)
    if settings.security_headers_enabled:
        _apply_security_headers(response)
    return response


@app.get("/api/auth/session")
def get_auth_session(request: Request) -> dict[str, Any]:
    settings = get_settings()
    if not settings.auth_required:
        return {"authenticated": True, "csrf_token": None, "expires_at": None, "auth_required": False}
    session = read_session(request, settings)
    return {
        "authenticated": bool(session),
        "csrf_token": session.csrf_token if session else None,
        "expires_at": session.expires_at if session else None,
        "auth_required": True,
    }


@app.post("/api/auth/session")
def create_auth_session(payload: dict[str, str], response: Response) -> dict[str, Any]:
    settings = get_settings()
    if not settings.auth_required:
        return {"authenticated": True, "csrf_token": None, "expires_at": None, "auth_required": False}
    if not authenticate_access_code(payload.get("access_code", ""), settings):
        raise HTTPException(status_code=401, detail="Invalid access code")
    return create_session(response, settings)


@app.post("/api/auth/logout")
def logout(response: Response) -> dict[str, Any]:
    return clear_session(response, get_settings())


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/system/status", response_model=SystemStatusRead)
def system_status() -> SystemStatusRead:
    settings = get_settings()
    provider = resolve_vlm_api_style(settings)
    return SystemStatusRead(
        app_env=settings.app_env,
        vlm_provider=provider,
        vlm_model_name=settings.resolved_vlm_model_name,
        has_vlm_credentials=bool(settings.resolved_vlm_api_key and settings.resolved_vlm_model_name),
        is_mock=provider == "mock",
    )


@app.get("/api/settings/vlm", response_model=VlmSettingsRead)
def get_vlm_settings() -> VlmSettingsRead:
    settings = get_settings()
    return VlmSettingsRead(
        provider=resolve_vlm_api_style(settings),
        model_name=settings.resolved_vlm_model_name,
        libreoffice_path=settings.libreoffice_path or DEFAULT_LIBREOFFICE_PATH,
        reasoning_effort=settings.vlm_reasoning_effort,
        verbosity=settings.vlm_verbosity,
        max_completion_tokens=settings.vlm_max_completion_tokens,
        top_p=settings.vlm_top_p,
        service_tier=settings.vlm_service_tier,
        batch_max_workers=settings.batch_max_workers,
        has_api_key=bool(settings.resolved_vlm_api_key),
        env_path=str(ROOT_ENV_PATH),
        runtime_settings_writable=settings.runtime_settings_writable,
    )


@app.put("/api/settings/vlm", response_model=VlmSettingsRead)
def update_vlm_settings(payload: VlmSettingsUpdate) -> VlmSettingsRead:
    settings = get_settings()
    if not settings.runtime_settings_writable:
        raise HTTPException(status_code=403, detail="Runtime settings are disabled in production. Use hosting environment variables.")

    provider = payload.provider.strip().lower() or "auto"
    if provider not in {"auto", "openai", "openai_compatible", "google", "gemini", "google_genai", "mock"}:
        raise HTTPException(status_code=400, detail="Use auto, mock, openai_compatible, or google_genai")

    updates = {
        "VLM_PROVIDER": provider,
        "VLM_MODEL_NAME": payload.model_name.strip(),
        "LIBREOFFICE_PATH": (payload.libreoffice_path or "").strip() or DEFAULT_LIBREOFFICE_PATH,
        "VLM_REASONING_EFFORT": (payload.reasoning_effort or "minimal").strip(),
        "VLM_VERBOSITY": (payload.verbosity or "low").strip(),
        "VLM_MAX_COMPLETION_TOKENS": (payload.max_completion_tokens or "").strip(),
        "VLM_TOP_P": (payload.top_p or "").strip(),
        "VLM_SERVICE_TIER": (payload.service_tier or "").strip(),
        "BATCH_MAX_WORKERS": str(payload.batch_max_workers or get_settings().batch_max_workers),
    }
    api_key = (payload.api_key or "").strip()
    if api_key:
        updates["VLM_API_KEY"] = api_key

    upsert_root_env(updates, include_defaults=True)
    return get_vlm_settings()


@app.post("/api/raw-extractions", response_model=RawExtractionRead)
def upload_raw_extraction(
    file: UploadFile = File(...),
    include_images: bool = Form(default=True),
    include_formulas: bool = Form(default=False),
    db: Session = Depends(get_db),
) -> RawExtractionRead:
    try:
        source_format = validate_raw_upload(file.filename or "")[1:]
    except RawExtractionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    raw = RawExtraction(
        filename=file.filename or "uploaded_document",
        source_format=source_format,
        size_bytes=0,
        status="processing",
    )
    db.add(raw)
    db.flush()

    try:
        filename, source_format, original_path, size_bytes = save_raw_upload(file, raw.id)
        raw.filename = filename
        raw.source_format = source_format
        raw.storage_path = str(original_path)
        raw.size_bytes = size_bytes
        pdf_path, html_path, warnings = create_raw_outputs(
            original_path,
            source_format,
            RawExtractionOptions(include_images=include_images, include_formulas=include_formulas),
        )
        if get_settings().storage_backend.strip().lower() == "s3":
            raw.storage_path = persist_artifact(original_path, f"raw/{raw.id}/original.{source_format}")
            raw.pdf_path = persist_artifact(pdf_path, f"raw/{raw.id}/preview.pdf", "application/pdf")
            raw.html_path = persist_artifact(html_path, f"raw/{raw.id}/content.html", "text/html; charset=utf-8")
        else:
            raw.pdf_path = str(pdf_path)
            raw.html_path = str(html_path)
        raw.warnings = json.dumps(warnings, ensure_ascii=False)
        raw.status = "completed"
        raw.error_message = None
    except RawExtractionError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:
        raw.status = "failed"
        raw.error_message = str(exc)
    db.commit()
    db.refresh(raw)
    return _raw_extraction_read(raw)


@app.get("/api/raw-extractions", response_model=list[RawExtractionRead])
def list_raw_extractions(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[RawExtractionRead]:
    rows = db.query(RawExtraction).order_by(RawExtraction.created_at.desc()).limit(limit).all()
    return [_raw_extraction_read(row) for row in rows]


@app.get("/api/raw-extractions/{raw_id}/pdf")
def get_raw_extraction_pdf(raw_id: str, db: Session = Depends(get_db)) -> FileResponse:
    raw = db.get(RawExtraction, raw_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Raw extraction not found")
    if not raw.pdf_path:
        raise HTTPException(status_code=404, detail="Raw extraction PDF preview is not available")
    path = materialize_storage_ref(raw.pdf_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Raw extraction PDF preview is missing")
    return FileResponse(path, media_type="application/pdf")


@app.get("/api/raw-extractions/{raw_id}/html")
def get_raw_extraction_html(raw_id: str, db: Session = Depends(get_db)) -> FileResponse:
    raw = db.get(RawExtraction, raw_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Raw extraction not found")
    if not raw.html_path:
        raise HTTPException(status_code=404, detail="Raw extraction HTML is not available")
    path = materialize_storage_ref(raw.html_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Raw extraction HTML is missing")
    return FileResponse(path, media_type="text/html")


@app.get("/api/raw-extractions/{raw_id}", response_model=RawExtractionRead)
def get_raw_extraction(raw_id: str, db: Session = Depends(get_db)) -> RawExtractionRead:
    raw = db.get(RawExtraction, raw_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Raw extraction not found")
    return _raw_extraction_read(raw)


@app.post("/api/documents", response_model=DocumentRead)
def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db)) -> DocumentRead:
    document = _create_document_from_upload(file, db)
    log_audit_event(
        db,
        entity_type="document",
        entity_id=document.id,
        action="uploaded",
        message=f"Uploaded {document.filename}",
        metadata={"filename": document.filename, "page_count": document.page_count},
    )
    db.commit()
    db.refresh(document)
    return _document_read(document)


@app.get("/api/documents", response_model=list[DocumentRead])
def list_documents(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[DocumentRead]:
    documents = db.query(Document).order_by(Document.created_at.desc()).limit(limit).all()
    return [_document_read(document) for document in documents]


@app.get("/api/documents/{document_id}", response_model=DocumentRead)
def get_document(document_id: str, db: Session = Depends(get_db)) -> DocumentRead:
    document = db.get(Document, document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    _repair_image_document_if_needed(document, db)
    return _document_read(document)


@app.get("/api/documents/{document_id}/pages/{page_number}/image")
def get_document_page_image(document_id: str, page_number: int, db: Session = Depends(get_db)) -> FileResponse:
    page = (
        db.query(DocumentPage)
        .filter(DocumentPage.document_id == document_id, DocumentPage.page_number == page_number)
        .one_or_none()
    )
    if not page:
        raise HTTPException(status_code=404, detail="Document page not found")
    document = db.get(Document, document_id)
    if document:
        _repair_image_document_if_needed(document, db)
        db.refresh(page)
    path = materialize_storage_ref(page.image_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document page image missing")
    return FileResponse(path, media_type="image/png")


@app.get("/api/documents/{document_id}/pages/{page_number}/thumbnail")
def get_document_page_thumbnail(
    document_id: str,
    page_number: int,
    width: int = Query(default=96, ge=48, le=512),
    db: Session = Depends(get_db),
) -> FileResponse:
    page = (
        db.query(DocumentPage)
        .filter(DocumentPage.document_id == document_id, DocumentPage.page_number == page_number)
        .one_or_none()
    )
    if not page:
        raise HTTPException(status_code=404, detail="Document page not found")
    document = db.get(Document, document_id)
    if document:
        _repair_image_document_if_needed(document, db)
        db.refresh(page)
    source_path = materialize_storage_ref(page.image_path)
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Document page image missing")

    thumbnail_path = source_path.with_name(f"{source_path.stem}_thumb_{width}.jpg")
    if not thumbnail_path.exists() or thumbnail_path.stat().st_mtime < source_path.stat().st_mtime:
        with Image.open(source_path) as source:
            image = source.convert("RGB")
            ratio = width / max(1, image.width)
            target_size = (width, max(1, round(image.height * ratio)))
            image = image.resize(target_size, Image.Resampling.LANCZOS)
            image.save(thumbnail_path, format="JPEG", quality=82, optimize=True)

    return FileResponse(thumbnail_path, media_type="image/jpeg")


@app.post("/api/schemas", response_model=SchemaRead)
def create_schema(payload: SchemaCreate, db: Session = Depends(get_db)) -> SchemaRead:
    _raise_if_schema_name_conflicts(db, payload.name)
    schema = Schema(
        name=payload.name,
        display_name=payload.display_name,
        description=payload.description,
        current_version=1,
        schema_json=json.dumps(payload.model_dump(), ensure_ascii=False),
        is_template=payload.is_template,
        template_category=payload.template_category,
        pinned=payload.pinned,
        ephemeral=False,
        archived=False,
    )
    db.add(schema)
    db.flush()
    schema_json = payload.model_dump()
    _validate_schema_region_references(schema_json)
    log_audit_event(
        db,
        entity_type="schema",
        entity_id=schema.id,
        action="created",
        message=f"Created schema {schema.name}",
        metadata={"is_template": schema.is_template, "field_count": len(payload.fields)},
    )
    db.commit()
    db.refresh(schema)
    return _schema_read(schema)


@app.get("/api/schemas", response_model=list[SchemaRead])
def list_schemas(
    templates: bool | None = None,
    include_ephemeral: bool = False,
    include_archived: bool = False,
    db: Session = Depends(get_db),
) -> list[SchemaRead]:
    query = db.query(Schema)
    if not include_ephemeral:
        query = query.filter(Schema.ephemeral == False)  # noqa: E712
    if not include_archived:
        query = query.filter(Schema.archived == False)  # noqa: E712
    if templates is not None:
        query = query.filter(Schema.is_template == templates)
    schemas = query.order_by(Schema.pinned.desc(), Schema.created_at.desc()).all()
    return [_schema_read(schema) for schema in schemas]


@app.post("/api/schemas/recommendations", response_model=SchemaRecommendationRead)
def recommend_schema(
    payload: SchemaRecommendationRequest,
    db: Session = Depends(get_db),
) -> SchemaRecommendationRead:
    document = db.get(Document, payload.document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    try:
        recommendation = recommend_schema_with_vlm([page.image_path for page in document.pages])
        recommendation_read = _schema_recommendation_read(recommendation)
        document.document_type = recommendation_read.document_type
        document.language = recommendation_read.language
        document.ai_summary = recommendation_read.description
        document.recommendation_reasoning = recommendation_read.reasoning
        log_audit_event(
            db,
            entity_type="document",
            entity_id=document.id,
            action="schema_recommended",
            message="AI schema recommendation generated",
            metadata={
                "document_type": recommendation_read.document_type,
                "language": recommendation_read.language,
                "field_count": len(recommendation_read.fields),
            },
        )
        db.commit()
        return recommendation_read
    except ValidationError as exc:
        raise HTTPException(status_code=502, detail=f"VLM returned an invalid schema recommendation: {exc}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=vlm_error_detail(exc)) from exc


@app.post("/api/schemas/description-recommendations", response_model=SchemaDescriptionRecommendationRead)
def recommend_schema_description(
    payload: SchemaDescriptionRecommendationRequest,
    db: Session = Depends(get_db),
) -> SchemaDescriptionRecommendationRead:
    image_paths: list[str] = []
    if payload.document_id:
        document = db.get(Document, payload.document_id)
        if not document:
            raise HTTPException(status_code=404, detail="Document not found")
        image_paths = [page.image_path for page in document.pages]
    try:
        recommendation = recommend_schema_description_with_vlm(
            image_paths,
            schema_name=payload.name,
            current_description=payload.current_description,
            fields=payload.fields,
        )
        return SchemaDescriptionRecommendationRead(**recommendation)
    except ValidationError as exc:
        raise HTTPException(status_code=502, detail=f"VLM returned an invalid schema description recommendation: {exc}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=vlm_error_detail(exc)) from exc


@app.get("/api/schemas/{schema_id}", response_model=SchemaRead)
def get_schema(schema_id: str, db: Session = Depends(get_db)) -> SchemaRead:
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    return _schema_read(schema)


@app.patch("/api/schemas/{schema_id}", response_model=SchemaRead)
def update_schema(schema_id: str, payload: SchemaUpdate, db: Session = Depends(get_db)) -> SchemaRead:
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")

    current = _schema_data(schema)
    next_schema_data = {
        "name": payload.name if payload.name is not None else schema.name,
        "display_name": (
            payload.display_name if "display_name" in payload.model_fields_set else schema.display_name
        ),
        "description": payload.description if "description" in payload.model_fields_set else schema.description,
        "is_template": payload.is_template if payload.is_template is not None else schema.is_template,
        "template_category": (
            payload.template_category if "template_category" in payload.model_fields_set else schema.template_category
        ),
        "pinned": payload.pinned if payload.pinned is not None else schema.pinned,
        "regions": [region.model_dump() for region in payload.regions] if payload.regions is not None else current.get("regions", []),
        "fields": [field.model_dump() for field in payload.fields] if payload.fields is not None else current["fields"],
    }
    _validate_schema_region_references(next_schema_data)
    if next_schema_data["name"].strip() == schema.name.strip():
        _merge_duplicate_schema_names_into(db, schema, next_schema_data["name"])
    else:
        _raise_if_schema_name_conflicts(db, next_schema_data["name"], schema_id=schema.id)

    schema.name = next_schema_data["name"]
    schema.display_name = next_schema_data["display_name"]
    schema.description = next_schema_data["description"]
    schema.is_template = next_schema_data["is_template"]
    schema.template_category = next_schema_data["template_category"]
    schema.pinned = next_schema_data["pinned"]
    schema.schema_json = json.dumps(next_schema_data, ensure_ascii=False)
    log_audit_event(
        db,
        entity_type="schema",
        entity_id=schema.id,
        action="updated",
        message=f"Updated schema {schema.name}",
        metadata={
            "is_template": schema.is_template,
            "field_count": len(next_schema_data["fields"]),
        },
    )
    db.commit()
    db.refresh(schema)
    return _schema_read(schema)


@app.delete("/api/schemas/{schema_id}", response_model=SchemaRead)
def delete_schema(schema_id: str, db: Session = Depends(get_db)) -> SchemaRead:
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    if schema.ephemeral:
        raise HTTPException(status_code=400, detail="Draft schemas cannot be archived from the library")

    schema.archived = True
    schema.pinned = False
    schema.is_template = False
    log_audit_event(
        db,
        entity_type="schema",
        entity_id=schema.id,
        action="archived",
        message=f"Archived schema {schema.name}",
        metadata={"name": schema.name},
    )
    db.commit()
    db.refresh(schema)
    return _schema_read(schema)


@app.post("/api/document-classifiers", response_model=DocumentClassifierRead)
def create_document_classifier(payload: DocumentClassifierCreate, db: Session = Depends(get_db)) -> DocumentClassifierRead:
    classifier = DocumentClassifier(
        name=payload.name,
        description=payload.description,
        allow_unknown=payload.allow_unknown,
        config_json=json.dumps(payload.model_dump(), ensure_ascii=False),
        archived=False,
    )
    db.add(classifier)
    db.flush()
    log_audit_event(
        db,
        entity_type="document_classifier",
        entity_id=classifier.id,
        action="created",
        message=f"Created document classifier {classifier.name}",
        metadata={"class_count": len(payload.classes)},
    )
    db.commit()
    db.refresh(classifier)
    return _classifier_read(classifier)


@app.get("/api/document-classifiers", response_model=list[DocumentClassifierRead])
def list_document_classifiers(
    include_archived: bool = False,
    db: Session = Depends(get_db),
) -> list[DocumentClassifierRead]:
    query = db.query(DocumentClassifier)
    if not include_archived:
        query = query.filter(DocumentClassifier.archived == False)  # noqa: E712
    rows = query.order_by(DocumentClassifier.created_at.desc()).all()
    return [_classifier_read(row) for row in rows]


@app.get("/api/document-classifiers/{classifier_id}", response_model=DocumentClassifierRead)
def get_document_classifier(classifier_id: str, db: Session = Depends(get_db)) -> DocumentClassifierRead:
    classifier = db.get(DocumentClassifier, classifier_id)
    if not classifier:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    return _classifier_read(classifier)


@app.patch("/api/document-classifiers/{classifier_id}", response_model=DocumentClassifierRead)
def update_document_classifier(
    classifier_id: str,
    payload: DocumentClassifierUpdate,
    db: Session = Depends(get_db),
) -> DocumentClassifierRead:
    classifier = db.get(DocumentClassifier, classifier_id)
    if not classifier:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    current = _classifier_data(classifier)
    next_config = {
        "name": payload.name if payload.name is not None else classifier.name,
        "description": payload.description if "description" in payload.model_fields_set else classifier.description,
        "allow_unknown": payload.allow_unknown if payload.allow_unknown is not None else classifier.allow_unknown,
        "classes": [item.model_dump() for item in payload.classes] if payload.classes is not None else current["classes"],
    }
    classifier.name = next_config["name"]
    classifier.description = next_config["description"]
    classifier.allow_unknown = bool(next_config["allow_unknown"])
    classifier.config_json = json.dumps(next_config, ensure_ascii=False)
    log_audit_event(
        db,
        entity_type="document_classifier",
        entity_id=classifier.id,
        action="updated",
        message=f"Updated document classifier {classifier.name}",
        metadata={"class_count": len(next_config["classes"])},
    )
    db.commit()
    db.refresh(classifier)
    return _classifier_read(classifier)


@app.delete("/api/document-classifiers/{classifier_id}", response_model=DocumentClassifierRead)
def delete_document_classifier(classifier_id: str, db: Session = Depends(get_db)) -> DocumentClassifierRead:
    classifier = db.get(DocumentClassifier, classifier_id)
    if not classifier:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    classifier.archived = True
    log_audit_event(
        db,
        entity_type="document_classifier",
        entity_id=classifier.id,
        action="archived",
        message=f"Archived document classifier {classifier.name}",
        metadata={"name": classifier.name},
    )
    db.commit()
    db.refresh(classifier)
    return _classifier_read(classifier)


@app.post("/api/classification-jobs", response_model=ClassificationJobRead)
def create_classification_job(
    payload: ClassificationJobCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> ClassificationJobRead:
    document = db.get(Document, payload.document_id)
    classifier = db.get(DocumentClassifier, payload.classifier_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    if not classifier or classifier.archived:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    _repair_image_document_if_needed(document, db)
    job = ClassificationJob(document_id=document.id, classifier_id=classifier.id, status="queued")
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="classification_job",
        entity_id=job.id,
        action="created",
        message="Classification job created",
        metadata={"document_id": document.id, "classifier_id": classifier.id},
    )
    db.commit()
    db.refresh(job)
    response = _classification_job_read(job)
    db.close()
    background_tasks.add_task(run_classification_job, job.id)
    return response


@app.get("/api/classification-jobs/{job_id}", response_model=ClassificationJobRead)
def get_classification_job(job_id: str, db: Session = Depends(get_db)) -> ClassificationJobRead:
    job = db.get(ClassificationJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Classification job not found")
    return _classification_job_read(job)


@app.patch("/api/classification-results/{result_id}", response_model=ClassificationResultRead)
def patch_classification_result(
    result_id: str,
    payload: ClassificationResultPatch,
    db: Session = Depends(get_db),
) -> ClassificationResultRead:
    result = db.get(ClassificationResult, result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Classification result not found")
    if payload.corrected_output is not None:
        result.corrected_output = json.dumps(payload.corrected_output, ensure_ascii=False)
    if payload.reviewed is not None:
        result.reviewed = payload.reviewed
    db.commit()
    db.refresh(result)
    return ClassificationResultRead(**classification_result_to_dict(result))


@app.post("/api/required-field-checklists", response_model=RequiredFieldChecklistRead)
def create_required_field_checklist(payload: RequiredFieldChecklistCreate, db: Session = Depends(get_db)) -> RequiredFieldChecklistRead:
    checklist = RequiredFieldChecklist(
        name=payload.name,
        description=payload.description,
        config_json=json.dumps(payload.model_dump(), ensure_ascii=False),
        archived=False,
    )
    db.add(checklist)
    db.flush()
    log_audit_event(
        db,
        entity_type="required_field_checklist",
        entity_id=checklist.id,
        action="created",
        message=f"Created required field checklist {checklist.name}",
        metadata={"item_count": len(payload.items)},
    )
    db.commit()
    db.refresh(checklist)
    return _checklist_read(checklist)


@app.get("/api/required-field-checklists", response_model=list[RequiredFieldChecklistRead])
def list_required_field_checklists(
    include_archived: bool = False,
    db: Session = Depends(get_db),
) -> list[RequiredFieldChecklistRead]:
    query = db.query(RequiredFieldChecklist)
    if not include_archived:
        query = query.filter(RequiredFieldChecklist.archived == False)  # noqa: E712
    rows = query.order_by(RequiredFieldChecklist.created_at.desc()).all()
    return [_checklist_read(row) for row in rows]


@app.post("/api/required-field-checklists/recommendations", response_model=RequiredFieldChecklistRecommendationRead)
def recommend_required_field_checklist(
    payload: RequiredFieldChecklistRecommendationRequest,
    db: Session = Depends(get_db),
) -> RequiredFieldChecklistRecommendationRead:
    document = db.get(Document, payload.document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    try:
        recommendation = recommend_required_field_checklist_with_vlm([page.image_path for page in document.pages])
        recommendation_read = _required_field_checklist_recommendation_read(recommendation)
        log_audit_event(
            db,
            entity_type="document",
            entity_id=document.id,
            action="required_field_checklist_recommended",
            message="AI required field checklist recommendation generated",
            metadata={
                "item_count": len(recommendation_read.items),
                "region_count": len(recommendation_read.regions),
            },
        )
        db.commit()
        return recommendation_read
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"VLM returned an invalid checklist recommendation: {exc}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=vlm_error_detail(exc)) from exc


@app.get("/api/required-field-checklists/{checklist_id}", response_model=RequiredFieldChecklistRead)
def get_required_field_checklist(checklist_id: str, db: Session = Depends(get_db)) -> RequiredFieldChecklistRead:
    checklist = db.get(RequiredFieldChecklist, checklist_id)
    if not checklist:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    return _checklist_read(checklist)


@app.patch("/api/required-field-checklists/{checklist_id}", response_model=RequiredFieldChecklistRead)
def update_required_field_checklist(
    checklist_id: str,
    payload: RequiredFieldChecklistUpdate,
    db: Session = Depends(get_db),
) -> RequiredFieldChecklistRead:
    checklist = db.get(RequiredFieldChecklist, checklist_id)
    if not checklist:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    current = _checklist_data(checklist)
    next_config = {
        "name": payload.name if payload.name is not None else checklist.name,
        "description": payload.description if "description" in payload.model_fields_set else checklist.description,
        "regions": [region.model_dump() for region in payload.regions] if payload.regions is not None else current.get("regions", []),
        "items": [item.model_dump() for item in payload.items] if payload.items is not None else current["items"],
    }
    _validate_checklist_region_references(next_config)
    checklist.name = next_config["name"]
    checklist.description = next_config["description"]
    checklist.config_json = json.dumps(next_config, ensure_ascii=False)
    log_audit_event(
        db,
        entity_type="required_field_checklist",
        entity_id=checklist.id,
        action="updated",
        message=f"Updated required field checklist {checklist.name}",
        metadata={"item_count": len(next_config["items"])},
    )
    db.commit()
    db.refresh(checklist)
    return _checklist_read(checklist)


@app.delete("/api/required-field-checklists/{checklist_id}", response_model=RequiredFieldChecklistRead)
def delete_required_field_checklist(checklist_id: str, db: Session = Depends(get_db)) -> RequiredFieldChecklistRead:
    checklist = db.get(RequiredFieldChecklist, checklist_id)
    if not checklist:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    checklist.archived = True
    log_audit_event(
        db,
        entity_type="required_field_checklist",
        entity_id=checklist.id,
        action="archived",
        message=f"Archived required field checklist {checklist.name}",
        metadata={"name": checklist.name},
    )
    db.commit()
    db.refresh(checklist)
    return _checklist_read(checklist)


@app.post("/api/required-field-check-jobs", response_model=RequiredFieldCheckJobRead)
def create_required_field_check_job(
    payload: RequiredFieldCheckJobCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckJobRead:
    document = db.get(Document, payload.document_id)
    checklist = db.get(RequiredFieldChecklist, payload.checklist_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    if not checklist or checklist.archived:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    _repair_image_document_if_needed(document, db)
    job = RequiredFieldCheckJob(document_id=document.id, checklist_id=checklist.id, status="queued")
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="required_field_check_job",
        entity_id=job.id,
        action="created",
        message="Required field check job created",
        metadata={"document_id": document.id, "checklist_id": checklist.id},
    )
    db.commit()
    db.refresh(job)
    response = _required_field_job_read(job)
    db.close()
    background_tasks.add_task(run_required_field_check_job, job.id)
    return response


@app.get("/api/required-field-check-jobs/{job_id}", response_model=RequiredFieldCheckJobRead)
def get_required_field_check_job(job_id: str, db: Session = Depends(get_db)) -> RequiredFieldCheckJobRead:
    job = db.get(RequiredFieldCheckJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Required field check job not found")
    return _required_field_job_read(job)


@app.patch("/api/required-field-check-results/{result_id}", response_model=RequiredFieldCheckResultRead)
def patch_required_field_check_result(
    result_id: str,
    payload: RequiredFieldCheckResultPatch,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckResultRead:
    result = db.get(RequiredFieldCheckResult, result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Required field check result not found")
    if payload.corrected_output is not None:
        result.corrected_output = json.dumps(payload.corrected_output, ensure_ascii=False)
    if payload.reviewed is not None:
        result.reviewed = payload.reviewed
    db.commit()
    db.refresh(result)
    return RequiredFieldCheckResultRead(**required_field_result_to_dict(result))


@app.post("/api/extraction-jobs", response_model=ExtractionJobRead)
def create_extraction_job(
    payload: ExtractionJobCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> ExtractionJobRead:
    document = db.get(Document, payload.document_id)
    schema = db.get(Schema, payload.schema_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    _repair_image_document_if_needed(document, db)

    job = ExtractionJob(
        document_id=document.id,
        schema_id=schema.id,
        schema_version=1,
        status="queued",
    )
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="extraction_job",
        entity_id=job.id,
        action="created",
        message="Extraction job created",
        metadata={"document_id": document.id, "schema_id": schema.id},
    )
    db.commit()
    db.refresh(job)
    response = _job_read(job)
    db.close()
    background_tasks.add_task(run_extraction_job, job.id)
    return response


@app.post("/api/extraction-jobs/draft", response_model=ExtractionJobRead)
def create_draft_extraction_job(
    payload: DraftExtractionJobCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> ExtractionJobRead:
    document = db.get(Document, payload.document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    _repair_image_document_if_needed(document, db)

    draft_schema = payload.schema_definition
    schema_data = draft_schema.model_dump()
    schema_data["is_template"] = False
    schema_data["template_category"] = None
    schema_data["pinned"] = False
    _validate_schema_region_references(schema_data)

    schema = Schema(
        name=draft_schema.name,
        display_name=draft_schema.display_name or draft_schema.name,
        description=draft_schema.description,
        current_version=1,
        schema_json=json.dumps(schema_data, ensure_ascii=False),
        is_template=False,
        template_category=None,
        pinned=False,
        ephemeral=True,
        archived=False,
    )
    db.add(schema)
    db.flush()
    job = ExtractionJob(
        document_id=document.id,
        schema_id=schema.id,
        schema_version=1,
        status="queued",
    )
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="extraction_job",
        entity_id=job.id,
        action="created",
        message="Draft extraction job created",
        metadata={"document_id": document.id, "schema_id": schema.id, "schema_mode": "draft"},
    )
    db.commit()
    db.refresh(job)
    response = _job_read(job)
    db.close()
    background_tasks.add_task(run_extraction_job, job.id)
    return response


@app.get("/api/extraction-jobs", response_model=list[ExtractionJobRead])
def list_extraction_jobs(
    document_id: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[ExtractionJobRead]:
    query = db.query(ExtractionJob)
    if document_id:
        query = query.filter(ExtractionJob.document_id == document_id)
    jobs = query.order_by(ExtractionJob.created_at.desc()).limit(limit).all()
    return [_job_read(job) for job in jobs]


@app.get("/api/extraction-jobs/{job_id}", response_model=ExtractionJobRead)
def get_extraction_job(job_id: str, db: Session = Depends(get_db)) -> ExtractionJobRead:
    job = db.get(ExtractionJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    return _job_read(job)


@app.patch("/api/extraction-results/{result_id}")
def patch_extraction_result(
    result_id: str,
    payload: ExtractionResultPatch,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    result = db.get(ExtractionResult, result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Extraction result not found")
    if payload.corrected_output is not None:
        result.corrected_output = json.dumps(payload.corrected_output, ensure_ascii=False)
    if payload.reviewed_fields is not None:
        result.reviewed_fields = json.dumps(payload.reviewed_fields, ensure_ascii=False)
    log_audit_event(
        db,
        entity_type="extraction_result",
        entity_id=result.id,
        action="review_saved",
        message="Review changes saved",
        metadata={
            "has_corrections": payload.corrected_output is not None,
            "reviewed_count": len(payload.reviewed_fields or []),
        },
    )
    db.commit()
    db.refresh(result)
    return result_to_dict(result)


@app.get("/api/extraction-results/{result_id}/export")
def export_extraction_result(
    result_id: str,
    format: str = Query(default="json", pattern="^(json|csv)$"),
    preset_id: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    result = db.get(ExtractionResult, result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Extraction result not found")

    payload = json.loads(result.corrected_output) if result.corrected_output else json.loads(result.validated_output)
    preset = db.get(ExportPreset, preset_id) if preset_id else None
    if preset_id and not preset:
        raise HTTPException(status_code=404, detail="Export preset not found")
    export_payload = _apply_export_preset(payload, preset) if preset else payload
    log_audit_event(
        db,
        entity_type="extraction_result",
        entity_id=result.id,
        action="exported",
        message=f"Exported {format.upper()}",
        metadata={"format": format, "preset_id": preset_id},
    )
    db.commit()
    if format == "json":
        return JSONResponse(export_payload)

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["key_name", "value", "normalized_value", "page", "confidence", "evidence", "warnings"],
    )
    writer.writeheader()
    for key, value in export_payload.get("values", {}).items():
        writer.writerow(
            {
                "key_name": key,
                "value": value.get("value"),
                "normalized_value": value.get("normalized_value"),
                "page": value.get("page"),
                "confidence": value.get("confidence"),
                "evidence": value.get("evidence"),
                "warnings": ";".join(value.get("warnings", [])),
            }
        )
    return _csv_download_response(output.getvalue(), f"{result_id}.csv")


@app.post("/api/export-presets", response_model=ExportPresetRead)
def create_export_preset(payload: ExportPresetCreate, db: Session = Depends(get_db)) -> ExportPresetRead:
    if payload.schema_id and not db.get(Schema, payload.schema_id):
        raise HTTPException(status_code=404, detail="Schema not found")
    preset = ExportPreset(
        schema_id=payload.schema_id,
        name=payload.name.strip(),
        fields_json=json.dumps([field.model_dump() for field in payload.fields], ensure_ascii=False),
    )
    db.add(preset)
    db.flush()
    log_audit_event(
        db,
        entity_type="export_preset",
        entity_id=preset.id,
        action="created",
        message=f"Created export preset {preset.name}",
        metadata={"schema_id": preset.schema_id},
    )
    db.commit()
    db.refresh(preset)
    return _export_preset_read(preset)


@app.get("/api/export-presets", response_model=list[ExportPresetRead])
def list_export_presets(schema_id: str | None = None, db: Session = Depends(get_db)) -> list[ExportPresetRead]:
    query = db.query(ExportPreset)
    if schema_id:
        query = query.filter((ExportPreset.schema_id == schema_id) | (ExportPreset.schema_id.is_(None)))
    presets = query.order_by(ExportPreset.created_at.desc()).all()
    return [_export_preset_read(preset) for preset in presets]


@app.patch("/api/export-presets/{preset_id}", response_model=ExportPresetRead)
def update_export_preset(
    preset_id: str,
    payload: ExportPresetUpdate,
    db: Session = Depends(get_db),
) -> ExportPresetRead:
    preset = db.get(ExportPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Export preset not found")
    if payload.schema_id and not db.get(Schema, payload.schema_id):
        raise HTTPException(status_code=404, detail="Schema not found")
    if payload.name is not None:
        preset.name = payload.name.strip()
    if "schema_id" in payload.model_fields_set:
        preset.schema_id = payload.schema_id
    if payload.fields is not None:
        preset.fields_json = json.dumps([field.model_dump() for field in payload.fields], ensure_ascii=False)
    log_audit_event(
        db,
        entity_type="export_preset",
        entity_id=preset.id,
        action="updated",
        message=f"Updated export preset {preset.name}",
        metadata={"schema_id": preset.schema_id},
    )
    db.commit()
    db.refresh(preset)
    return _export_preset_read(preset)


@app.delete("/api/export-presets/{preset_id}")
def delete_export_preset(preset_id: str, db: Session = Depends(get_db)) -> dict[str, str]:
    preset = db.get(ExportPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Export preset not found")
    log_audit_event(
        db,
        entity_type="export_preset",
        entity_id=preset.id,
        action="deleted",
        message=f"Deleted export preset {preset.name}",
        metadata={"schema_id": preset.schema_id},
    )
    db.delete(preset)
    db.commit()
    return {"status": "deleted"}


@app.post("/api/workflows", response_model=WorkflowDefinitionRead)
def create_workflow(payload: WorkflowDefinitionCreate, db: Session = Depends(get_db)) -> WorkflowDefinitionRead:
    try:
        validate_workflow_definition(payload.definition, db)
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors}) from exc
    workflow = WorkflowDefinition(
        name=payload.name.strip(),
        description=payload.description,
        definition_json=json.dumps(payload.definition, ensure_ascii=False),
        archived=False,
    )
    db.add(workflow)
    db.flush()
    log_audit_event(
        db,
        entity_type="workflow_definition",
        entity_id=workflow.id,
        action="created",
        message=f"Created workflow {workflow.name}",
        metadata={"node_count": len(payload.definition.get("nodes", [])), "edge_count": len(payload.definition.get("edges", []))},
    )
    db.commit()
    db.refresh(workflow)
    return WorkflowDefinitionRead(**workflow_definition_to_read(workflow, db))


@app.get("/api/workflows", response_model=list[WorkflowDefinitionRead])
def list_workflows(include_archived: bool = False, db: Session = Depends(get_db)) -> list[WorkflowDefinitionRead]:
    query = db.query(WorkflowDefinition)
    if not include_archived:
        query = query.filter(WorkflowDefinition.archived == False)  # noqa: E712
    workflows = query.order_by(WorkflowDefinition.created_at.desc()).all()
    return [WorkflowDefinitionRead(**workflow_definition_to_read(workflow, db)) for workflow in workflows]


@app.get("/api/workflows/{workflow_id}", response_model=WorkflowDefinitionRead)
def get_workflow(workflow_id: str, db: Session = Depends(get_db)) -> WorkflowDefinitionRead:
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow or workflow.archived:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return WorkflowDefinitionRead(**workflow_definition_to_read(workflow, db))


@app.patch("/api/workflows/{workflow_id}", response_model=WorkflowDefinitionRead)
def update_workflow(
    workflow_id: str,
    payload: WorkflowDefinitionUpdate,
    db: Session = Depends(get_db),
) -> WorkflowDefinitionRead:
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow or workflow.archived:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if payload.definition is not None:
        try:
            validate_workflow_definition(payload.definition, db)
        except WorkflowDefinitionError as exc:
            raise HTTPException(status_code=422, detail={"errors": exc.errors}) from exc
        workflow.definition_json = json.dumps(payload.definition, ensure_ascii=False)
    if payload.name is not None:
        workflow.name = payload.name.strip()
    if "description" in payload.model_fields_set:
        workflow.description = payload.description
    log_audit_event(
        db,
        entity_type="workflow_definition",
        entity_id=workflow.id,
        action="updated",
        message=f"Updated workflow {workflow.name}",
        metadata={},
    )
    db.commit()
    db.refresh(workflow)
    return WorkflowDefinitionRead(**workflow_definition_to_read(workflow, db))


@app.delete("/api/workflows/{workflow_id}", response_model=WorkflowDefinitionRead)
def delete_workflow(workflow_id: str, db: Session = Depends(get_db)) -> WorkflowDefinitionRead:
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    workflow.archived = True
    log_audit_event(
        db,
        entity_type="workflow_definition",
        entity_id=workflow.id,
        action="archived",
        message=f"Archived workflow {workflow.name}",
        metadata={},
    )
    db.commit()
    db.refresh(workflow)
    return WorkflowDefinitionRead(**workflow_definition_to_read(workflow, db))


@app.post("/api/workflows/{workflow_id}/runs", response_model=WorkflowRunRead)
def create_workflow_run(
    workflow_id: str,
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow or workflow.archived:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)
    try:
        validate_workflow_definition(json.loads(workflow.definition_json), db)
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors}) from exc

    run = WorkflowRun(workflow_id=workflow.id, status="running", total_count=len(files))
    db.add(run)
    db.flush()
    for file in sorted(files, key=_upload_file_sort_key):
        document = _create_document_from_upload(file, db)
        db.flush()
        db.add(
            WorkflowRunItem(
                run_id=run.id,
                document_id=document.id,
                filename=document.filename,
                status="queued",
                result_json=json.dumps({"document_id": document.id, "filename": document.filename, "node_results": {}}, ensure_ascii=False),
            )
        )
        log_audit_event(
            db,
            entity_type="workflow_run_item",
            entity_id=run.id,
            action="queued",
            message=f"Queued workflow document {document.filename}",
            metadata={"document_id": document.id},
        )
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="created",
        message=f"Created workflow run with {len(files)} file(s)",
        metadata={"workflow_id": workflow.id, "file_count": len(files)},
    )
    db.commit()
    db.refresh(run)
    response = WorkflowRunRead(**workflow_run_to_read(run))
    db.close()
    background_tasks.add_task(run_workflow_run, run.id)
    return response


@app.get("/api/workflow-runs", response_model=list[WorkflowRunRead])
def list_workflow_runs(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)) -> list[WorkflowRunRead]:
    runs = db.query(WorkflowRun).order_by(WorkflowRun.created_at.desc()).limit(limit).all()
    return [WorkflowRunRead(**workflow_run_to_read(run)) for run in runs]


@app.get("/api/workflow-runs/{run_id}", response_model=WorkflowRunRead)
def get_workflow_run(run_id: str, db: Session = Depends(get_db)) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    return WorkflowRunRead(**workflow_run_to_read(run))


@app.get("/api/workflow-runs/{run_id}/export")
def export_workflow_run(
    run_id: str,
    format: str = Query(default="csv", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
) -> Response:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    payload = workflow_run_export_payload(run)
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="exported",
        message=f"Exported workflow run {format.upper()}",
        metadata={"format": format},
    )
    db.commit()
    if format == "json":
        return JSONResponse(payload, headers={"Content-Disposition": f'attachment; filename="{run.id}.json"'})
    return _csv_download_response(workflow_run_export_csv(run), f"{run.id}.csv")


@app.post("/api/batches", response_model=BatchRead)
def create_batch(
    background_tasks: BackgroundTasks,
    schema_id: str = Form(...),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> BatchRead:
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)

    batch = Batch(schema_id=schema.id, schema_version=1, status="running", total_count=len(files))
    db.add(batch)
    db.flush()
    job_ids: list[str] = []
    for file in sorted(files, key=_upload_file_sort_key):
        document = _create_document_from_upload(file, db)
        job = ExtractionJob(
            document_id=document.id,
            schema_id=schema.id,
            schema_version=1,
            status="queued",
        )
        db.add(job)
        db.flush()
        db.add(BatchItem(batch_id=batch.id, document_id=document.id, job_id=job.id, filename=document.filename))
        log_audit_event(
            db,
            entity_type="document",
            entity_id=document.id,
            action="uploaded",
            message=f"Batch uploaded {document.filename}",
            metadata={"batch_id": batch.id, "filename": document.filename},
        )
        log_audit_event(
            db,
            entity_type="extraction_job",
            entity_id=job.id,
            action="created",
            message="Batch extraction job created",
            metadata={"batch_id": batch.id, "document_id": document.id, "schema_id": schema.id},
        )
        job_ids.append(job.id)

    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="created",
        message=f"Created batch with {len(files)} file(s)",
        metadata={"schema_id": schema.id, "file_count": len(files)},
    )
    db.commit()
    db.refresh(batch)
    response = _batch_read(batch)
    db.close()
    background_tasks.add_task(run_batch_jobs, batch.id, job_ids)
    return response


@app.get("/api/batches", response_model=list[BatchRead])
def list_batches(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)) -> list[BatchRead]:
    batches = db.query(Batch).order_by(Batch.created_at.desc()).limit(limit).all()
    return [_batch_read(batch) for batch in batches]


@app.get("/api/batches/{batch_id}", response_model=BatchRead)
def get_batch(batch_id: str, db: Session = Depends(get_db)) -> BatchRead:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    return _batch_read(batch)


@app.post("/api/batches/{batch_id}/cancel", response_model=BatchRead)
def cancel_batch(batch_id: str, db: Session = Depends(get_db)) -> BatchRead:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")

    canceled_count = 0
    now = datetime.utcnow()
    for item in batch.items:
        if item.job and item.job.status in {"queued", "running"}:
            item.job.status = "canceled"
            item.job.error_message = "Canceled by user"
            item.job.completed_at = now
            canceled_count += 1

    if canceled_count:
        _close_batch_if_all_jobs_terminal(batch, now)
        if batch.status not in {"canceled", "completed", "completed_with_errors"}:
            batch.status = "cancel_requested"
        log_audit_event(
            db,
            entity_type="batch",
            entity_id=batch.id,
            action="cancel_requested",
            message=f"Cancel requested for {canceled_count} running or queued job(s)",
            metadata={"canceled_count": canceled_count},
        )
    else:
        log_audit_event(
            db,
            entity_type="batch",
            entity_id=batch.id,
            action="cancel_skipped",
            message="No running or queued batch jobs to cancel",
            metadata={},
        )

    db.commit()
    db.refresh(batch)
    return _batch_read(batch)


@app.get("/api/batches/{batch_id}/export")
def export_batch(
    batch_id: str,
    format: str = Query(default="csv", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
) -> Response:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")

    schema = db.get(Schema, batch.schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")

    schema_data = _schema_data(schema)
    field_names = [field["key_name"] for field in schema_data.get("fields", [])]
    rows = [_batch_export_row(item, field_names) for item in _sorted_batch_items(batch.items)]
    payload = {
        "batch_id": batch.id,
        "schema_id": batch.schema_id,
        "status": _batch_read(batch).status,
        "total_count": batch.total_count,
        "rows": rows,
    }
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="exported",
        message=f"Exported batch {format.upper()}",
        metadata={"format": format},
    )
    db.commit()

    if format == "json":
        return JSONResponse(
            payload,
            headers={"Content-Disposition": f'attachment; filename="{batch.id}.json"'},
        )

    output = io.StringIO()
    fieldnames = [
        "filename",
        "document_id",
        "job_id",
        "status",
        "error_message",
        *field_names,
        "warnings",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_cell(row.get(key)) for key in fieldnames})

    return _csv_download_response(output.getvalue(), f"{batch.id}.csv")


@app.post("/api/classification-batches", response_model=ClassificationBatchRead)
def create_classification_batch(
    background_tasks: BackgroundTasks,
    classifier_id: str = Form(...),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> ClassificationBatchRead:
    classifier = db.get(DocumentClassifier, classifier_id)
    if not classifier or classifier.archived:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)

    batch = ClassificationBatch(classifier_id=classifier.id, status="running", total_count=len(files))
    db.add(batch)
    db.flush()
    job_ids: list[str] = []
    for file in sorted(files, key=_upload_file_sort_key):
        document = _create_document_from_upload(file, db)
        db.flush()
        job = ClassificationJob(document_id=document.id, classifier_id=classifier.id, status="queued")
        db.add(job)
        db.flush()
        db.add(
            ClassificationBatchItem(
                batch_id=batch.id,
                document_id=document.id,
                job_id=job.id,
                filename=document.filename,
            )
        )
        log_audit_event(
            db,
            entity_type="classification_job",
            entity_id=job.id,
            action="queued",
            message="Queued classification batch job",
            metadata={"batch_id": batch.id, "document_id": document.id, "classifier_id": classifier.id},
        )
        job_ids.append(job.id)

    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="created",
        message=f"Created classification batch with {len(files)} file(s)",
        metadata={"classifier_id": classifier.id, "file_count": len(files)},
    )
    db.commit()
    db.refresh(batch)
    response = _classification_batch_read(batch)
    db.close()
    background_tasks.add_task(run_classification_batch, batch.id, job_ids)
    return response


@app.get("/api/classification-batches", response_model=list[ClassificationBatchRead])
def list_classification_batches(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[ClassificationBatchRead]:
    batches = db.query(ClassificationBatch).order_by(ClassificationBatch.created_at.desc()).limit(limit).all()
    return [_classification_batch_read(batch) for batch in batches]


@app.get("/api/classification-batches/{batch_id}", response_model=ClassificationBatchRead)
def get_classification_batch(batch_id: str, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    return _classification_batch_read(batch)


@app.post("/api/classification-batches/{batch_id}/cancel", response_model=ClassificationBatchRead)
def cancel_classification_batch(batch_id: str, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    _cancel_module_batch(batch, "classification_batch", db)
    db.commit()
    db.refresh(batch)
    return _classification_batch_read(batch)


@app.get("/api/classification-batches/{batch_id}/export")
def export_classification_batch(
    batch_id: str,
    format: str = Query(default="csv", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
) -> Response:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    rows = [_classification_batch_export_row(item) for item in _sorted_module_items(batch.items)]
    payload = {
        "batch_id": batch.id,
        "classifier_id": batch.classifier_id,
        "status": _classification_batch_read(batch).status,
        "total_count": batch.total_count,
        "rows": rows,
    }
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="exported",
        message=f"Exported classification batch {format.upper()}",
        metadata={"format": format},
    )
    db.commit()
    if format == "json":
        return JSONResponse(payload, headers={"Content-Disposition": f'attachment; filename="{batch.id}.json"'})

    output = io.StringIO()
    fieldnames = [
        "filename",
        "document_id",
        "job_id",
        "status",
        "error_message",
        "classification_status",
        "class_name",
        "confidence",
        "reason",
        "evidence",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_cell(row.get(key)) for key in fieldnames})
    return _csv_download_response(output.getvalue(), f"{batch.id}.csv")


@app.post("/api/required-field-check-batches", response_model=RequiredFieldCheckBatchRead)
def create_required_field_check_batch(
    background_tasks: BackgroundTasks,
    checklist_id: str = Form(...),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> RequiredFieldCheckBatchRead:
    checklist = db.get(RequiredFieldChecklist, checklist_id)
    if not checklist or checklist.archived:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)

    batch = RequiredFieldCheckBatch(checklist_id=checklist.id, status="running", total_count=len(files))
    db.add(batch)
    db.flush()
    job_ids: list[str] = []
    for file in sorted(files, key=_upload_file_sort_key):
        document = _create_document_from_upload(file, db)
        db.flush()
        job = RequiredFieldCheckJob(document_id=document.id, checklist_id=checklist.id, status="queued")
        db.add(job)
        db.flush()
        db.add(
            RequiredFieldCheckBatchItem(
                batch_id=batch.id,
                document_id=document.id,
                job_id=job.id,
                filename=document.filename,
            )
        )
        log_audit_event(
            db,
            entity_type="required_field_check_job",
            entity_id=job.id,
            action="queued",
            message="Queued required field check batch job",
            metadata={"batch_id": batch.id, "document_id": document.id, "checklist_id": checklist.id},
        )
        job_ids.append(job.id)

    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="created",
        message=f"Created required field check batch with {len(files)} file(s)",
        metadata={"checklist_id": checklist.id, "file_count": len(files)},
    )
    db.commit()
    db.refresh(batch)
    response = _required_field_batch_read(batch)
    db.close()
    background_tasks.add_task(run_required_field_check_batch, batch.id, job_ids)
    return response


@app.get("/api/required-field-check-batches", response_model=list[RequiredFieldCheckBatchRead])
def list_required_field_check_batches(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[RequiredFieldCheckBatchRead]:
    batches = db.query(RequiredFieldCheckBatch).order_by(RequiredFieldCheckBatch.created_at.desc()).limit(limit).all()
    return [_required_field_batch_read(batch) for batch in batches]


@app.get("/api/required-field-check-batches/{batch_id}", response_model=RequiredFieldCheckBatchRead)
def get_required_field_check_batch(batch_id: str, db: Session = Depends(get_db)) -> RequiredFieldCheckBatchRead:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    return _required_field_batch_read(batch)


@app.post("/api/required-field-check-batches/{batch_id}/cancel", response_model=RequiredFieldCheckBatchRead)
def cancel_required_field_check_batch(batch_id: str, db: Session = Depends(get_db)) -> RequiredFieldCheckBatchRead:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    _cancel_module_batch(batch, "required_field_check_batch", db)
    db.commit()
    db.refresh(batch)
    return _required_field_batch_read(batch)


@app.get("/api/required-field-check-batches/{batch_id}/export")
def export_required_field_check_batch(
    batch_id: str,
    format: str = Query(default="csv", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
) -> Response:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    checklist = db.get(RequiredFieldChecklist, batch.checklist_id)
    if not checklist:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    item_names = [item.get("item_name") for item in _checklist_data(checklist).get("items", []) if item.get("item_name")]
    rows = [_required_field_batch_export_row(item, item_names) for item in _sorted_module_items(batch.items)]
    payload = {
        "batch_id": batch.id,
        "checklist_id": batch.checklist_id,
        "status": _required_field_batch_read(batch).status,
        "total_count": batch.total_count,
        "rows": rows,
    }
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="exported",
        message=f"Exported required field check batch {format.upper()}",
        metadata={"format": format},
    )
    db.commit()
    if format == "json":
        return JSONResponse(payload, headers={"Content-Disposition": f'attachment; filename="{batch.id}.json"'})

    output = io.StringIO()
    item_columns = [f"{name}_status" for name in item_names] + [f"{name}_evidence" for name in item_names]
    fieldnames = [
        "filename",
        "document_id",
        "job_id",
        "status",
        "error_message",
        "overall_status",
        *item_columns,
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_cell(row.get(key)) for key in fieldnames})
    return _csv_download_response(output.getvalue(), f"{batch.id}.csv")


@app.get("/api/archive/search", response_model=list[ArchiveSearchResult])
def archive_search(
    q: str | None = None,
    status: str | None = None,
    schema_id: str | None = None,
    document_type: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[ArchiveSearchResult]:
    return _archive_search(db, q=q, status=status, schema_id=schema_id, document_type=document_type, limit=limit)


@app.delete("/api/maintenance/parsing-history")
def clear_parsing_history(db: Session = Depends(get_db)) -> dict[str, Any]:
    settings = get_settings()
    counts = {
        "batches": db.query(Batch).count(),
        "batch_items": db.query(BatchItem).count(),
        "classification_batches": db.query(ClassificationBatch).count(),
        "classification_batch_items": db.query(ClassificationBatchItem).count(),
        "classification_jobs": db.query(ClassificationJob).count(),
        "classification_results": db.query(ClassificationResult).count(),
        "required_field_check_batches": db.query(RequiredFieldCheckBatch).count(),
        "required_field_check_batch_items": db.query(RequiredFieldCheckBatchItem).count(),
        "required_field_check_jobs": db.query(RequiredFieldCheckJob).count(),
        "required_field_check_results": db.query(RequiredFieldCheckResult).count(),
        "workflow_runs": db.query(WorkflowRun).count(),
        "workflow_run_items": db.query(WorkflowRunItem).count(),
        "documents": db.query(Document).count(),
        "document_pages": db.query(DocumentPage).count(),
        "extraction_jobs": db.query(ExtractionJob).count(),
        "extraction_results": db.query(ExtractionResult).count(),
        "raw_extractions": db.query(RawExtraction).count(),
        "audit_events": db.query(AuditEvent).count(),
        "draft_schemas": db.query(Schema).filter(Schema.ephemeral == True).count(),  # noqa: E712
    }

    ephemeral_schema_ids = [row[0] for row in db.query(Schema.id).filter(Schema.ephemeral == True).all()]  # noqa: E712
    db.query(ClassificationBatchItem).delete(synchronize_session=False)
    db.query(ClassificationBatch).delete(synchronize_session=False)
    db.query(ClassificationResult).delete(synchronize_session=False)
    db.query(ClassificationJob).delete(synchronize_session=False)
    db.query(RequiredFieldCheckBatchItem).delete(synchronize_session=False)
    db.query(RequiredFieldCheckBatch).delete(synchronize_session=False)
    db.query(RequiredFieldCheckResult).delete(synchronize_session=False)
    db.query(RequiredFieldCheckJob).delete(synchronize_session=False)
    db.query(WorkflowRunItem).delete(synchronize_session=False)
    db.query(WorkflowRun).delete(synchronize_session=False)
    db.query(BatchItem).delete(synchronize_session=False)
    db.query(Batch).delete(synchronize_session=False)
    db.query(ExtractionResult).delete(synchronize_session=False)
    db.query(ExtractionJob).delete(synchronize_session=False)
    db.query(DocumentPage).delete(synchronize_session=False)
    db.query(Document).delete(synchronize_session=False)
    db.query(RawExtraction).delete(synchronize_session=False)
    db.query(AuditEvent).delete(synchronize_session=False)
    if ephemeral_schema_ids:
        db.query(Schema).filter(Schema.id.in_(ephemeral_schema_ids)).delete(synchronize_session=False)
    db.commit()

    removed_paths: list[str] = []
    for path in [settings.resolved_storage_dir, settings.resolved_raw_storage_dir]:
        if path.exists():
            shutil.rmtree(path)
            removed_paths.append(str(path))
        path.mkdir(parents=True, exist_ok=True)

    return {"status": "cleared", "counts": counts, "removed_paths": removed_paths}


@app.post("/api/maintenance/retention-cleanup")
def run_retention_cleanup() -> dict[str, Any]:
    return _cleanup_expired_upload_data()


@app.get("/api/audit-events", response_model=list[AuditEventRead])
def list_audit_events(
    entity_type: str | None = None,
    entity_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[AuditEventRead]:
    query = db.query(AuditEvent)
    if entity_type:
        query = query.filter(AuditEvent.entity_type == entity_type)
    if entity_id:
        query = query.filter(AuditEvent.entity_id == entity_id)
    events = query.order_by(AuditEvent.created_at.desc()).limit(limit).all()
    return [_audit_event_read(event) for event in events]


def _document_read(document: Document) -> DocumentRead:
    return DocumentRead(
        document_id=document.id,
        filename=document.filename,
        mime_type=document.mime_type,
        size_bytes=document.size_bytes,
        page_count=document.page_count,
        status=document.status,
        document_type=document.document_type,
        language=document.language,
        ai_summary=document.ai_summary,
        recommendation_reasoning=document.recommendation_reasoning,
        created_at=document.created_at,
        pages=[
            DocumentPageRead(
                id=page.id,
                page=page.page_number,
                image_url=f"/api/documents/{document.id}/pages/{page.page_number}/image",
                width=page.width,
                height=page.height,
            )
            for page in document.pages
        ],
    )


def _repair_image_document_if_needed(document: Document, db: Session) -> None:
    source_path = materialize_storage_ref(document.storage_path)
    if not is_supported_image(source_path) or not source_path.exists() or not document.pages:
        return

    page = document.pages[0]
    try:
        source_width, source_height = read_image_size(source_path)
    except DocumentProcessingError:
        return
    page_path = materialize_storage_ref(page.image_path)
    if page.width == source_width and page.height == source_height and page_path.exists():
        return

    try:
        page_info = rasterize_image_page(source_path, scratch_dir_for_ref(page.image_path, "repair"))
    except DocumentProcessingError:
        return

    next_width = int(page_info["width"])
    next_height = int(page_info["height"])
    if page.width == next_width and page.height == next_height and page_path.exists():
        return

    if get_settings().storage_backend.strip().lower() == "s3":
        image_path = Path(str(page_info["image_path"]))
        page.image_path = persist_artifact(image_path, f"documents/{document.id}/pages/{image_path.name}", "image/png")
    else:
        page.image_path = str(page_info["image_path"])
    page.width = next_width
    page.height = next_height
    document.page_count = 1
    db.commit()
    db.refresh(document)


def _raw_extraction_read(raw: RawExtraction) -> RawExtractionRead:
    return RawExtractionRead(
        id=raw.id,
        filename=raw.filename,
        source_format=raw.source_format,
        size_bytes=raw.size_bytes,
        status=raw.status,
        pdf_url=f"/api/raw-extractions/{raw.id}/pdf" if raw.pdf_path else None,
        html_url=f"/api/raw-extractions/{raw.id}/html" if raw.html_path else None,
        warnings=json.loads(raw.warnings or "[]"),
        error_message=raw.error_message,
        created_at=raw.created_at,
        updated_at=raw.updated_at,
    )


def _create_document_from_upload(file: UploadFile, db: Session) -> Document:
    try:
        filename, original_path, size_bytes = save_upload_file(file)
        pages = rasterize_document(original_path)
        storage_ref, pages = _persist_document_artifacts(original_path, pages)
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Failed to process uploaded document") from exc

    document = Document(
        filename=filename,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=size_bytes,
        page_count=len(pages),
        storage_path=storage_ref,
        status="ready",
    )
    db.add(document)
    db.flush()
    for page in pages:
        db.add(
            DocumentPage(
                document_id=document.id,
                page_number=int(page["page_number"]),
                image_path=str(page["image_path"]),
                width=int(page["width"]),
                height=int(page["height"]),
            )
        )
    return document


def _persist_document_artifacts(original_path: Path, pages: list[dict[str, int | str]]) -> tuple[str, list[dict[str, int | str]]]:
    settings = get_settings()
    if settings.storage_backend.strip().lower() != "s3":
        return str(original_path), pages
    document_key = original_path.parent.name
    original_ref = persist_artifact(original_path, f"documents/{document_key}/original{original_path.suffix}")
    persisted_pages: list[dict[str, int | str]] = []
    for page in pages:
        image_path = Path(str(page["image_path"]))
        page_ref = persist_artifact(image_path, f"documents/{document_key}/pages/{image_path.name}", "image/png")
        persisted_pages.append({**page, "image_path": page_ref})
    return original_ref, persisted_pages


def _schema_read(schema: Schema) -> SchemaRead:
    schema_data = _schema_data(schema)
    return SchemaRead(
        id=schema.id,
        name=schema.name,
        display_name=schema.display_name,
        description=schema.description,
        is_template=schema.is_template,
        template_category=schema.template_category,
        pinned=schema.pinned,
        ephemeral=schema.ephemeral,
        archived=schema.archived,
        regions=schema_data.get("regions", []),
        fields=schema_data["fields"],
        created_at=schema.created_at,
        updated_at=schema.updated_at,
    )


def _schema_data(schema: Schema) -> dict[str, Any]:
    if not schema.schema_json or schema.schema_json == "{}":
        raise HTTPException(status_code=500, detail="Schema data is missing")
    return json.loads(schema.schema_json)


def _classifier_read(classifier: DocumentClassifier) -> DocumentClassifierRead:
    data = _classifier_data(classifier)
    return DocumentClassifierRead(
        id=classifier.id,
        name=classifier.name,
        description=classifier.description,
        allow_unknown=classifier.allow_unknown,
        archived=classifier.archived,
        classes=data["classes"],
        created_at=classifier.created_at,
        updated_at=classifier.updated_at,
    )


def _classifier_data(classifier: DocumentClassifier) -> dict[str, Any]:
    if not classifier.config_json or classifier.config_json == "{}":
        raise HTTPException(status_code=500, detail="Document classifier data is missing")
    return json.loads(classifier.config_json)


def _classification_job_read(job: ClassificationJob) -> ClassificationJobRead:
    return ClassificationJobRead(
        job_id=job.id,
        document_id=job.document_id,
        classifier_id=job.classifier_id,
        status=job.status,
        error_message=job.error_message,
        result_id=job.result_id,
        result=ClassificationResultRead(**classification_result_to_dict(job.result)) if job.result else None,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


def _checklist_read(checklist: RequiredFieldChecklist) -> RequiredFieldChecklistRead:
    data = _checklist_data(checklist)
    return RequiredFieldChecklistRead(
        id=checklist.id,
        name=checklist.name,
        description=checklist.description,
        archived=checklist.archived,
        regions=data.get("regions", []),
        items=data["items"],
        created_at=checklist.created_at,
        updated_at=checklist.updated_at,
    )


def _checklist_data(checklist: RequiredFieldChecklist) -> dict[str, Any]:
    if not checklist.config_json or checklist.config_json == "{}":
        raise HTTPException(status_code=500, detail="Required field checklist data is missing")
    return json.loads(checklist.config_json)


def _required_field_checklist_recommendation_read(payload: dict[str, Any]) -> RequiredFieldChecklistRecommendationRead:
    recommendation = RequiredFieldChecklistRecommendationRead(**payload)
    region_ids = {region.id for region in recommendation.regions}
    seen_items: set[str] = set()
    unique_items = []
    for item in recommendation.items:
        if item.item_name in seen_items:
            continue
        seen_items.add(item.item_name)
        if item.region_id and item.region_id not in region_ids:
            item = item.model_copy(update={"region_id": None})
        unique_items.append(item)
    if not unique_items:
        raise ValueError("checklist recommendation must include at least one item")
    return RequiredFieldChecklistRecommendationRead(
        name=recommendation.name.strip() or "ai_recommended_checklist",
        description=recommendation.description,
        reasoning=recommendation.reasoning,
        regions=recommendation.regions,
        items=unique_items,
    )


def _validate_checklist_region_references(checklist_data: dict[str, Any]) -> None:
    item_names = [item.get("item_name") for item in checklist_data.get("items", []) if isinstance(item, dict)]
    if len(item_names) != len(set(item_names)):
        raise HTTPException(status_code=422, detail="required field item_name values must be unique")
    region_ids = [region.get("id") for region in checklist_data.get("regions", []) if isinstance(region, dict)]
    if len(region_ids) != len(set(region_ids)):
        raise HTTPException(status_code=422, detail="required field region ids must be unique")
    region_id_set = set(region_ids)
    missing_region_ids = sorted(
        {
            item.get("region_id")
            for item in checklist_data.get("items", [])
            if isinstance(item, dict) and item.get("region_id") and item.get("region_id") not in region_id_set
        }
    )
    if missing_region_ids:
        raise HTTPException(
            status_code=422,
            detail=f"required field item region_id values are missing from regions: {', '.join(missing_region_ids)}",
        )


def _required_field_job_read(job: RequiredFieldCheckJob) -> RequiredFieldCheckJobRead:
    return RequiredFieldCheckJobRead(
        job_id=job.id,
        document_id=job.document_id,
        checklist_id=job.checklist_id,
        status=job.status,
        error_message=job.error_message,
        result_id=job.result_id,
        result=RequiredFieldCheckResultRead(**required_field_result_to_dict(job.result)) if job.result else None,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


def _validate_schema_region_references(schema_data: dict[str, Any]) -> None:
    region_ids = {region.get("id") for region in schema_data.get("regions", []) if isinstance(region, dict)}
    missing_region_ids = sorted(
        {
            field.get("region_id")
            for field in schema_data.get("fields", [])
            if isinstance(field, dict) and field.get("region_id") and field.get("region_id") not in region_ids
        }
    )
    if missing_region_ids:
        raise HTTPException(
            status_code=422,
            detail=f"schema field region_id values are missing from regions: {', '.join(missing_region_ids)}",
        )


def _raise_if_schema_name_conflicts(db: Session, name: str, schema_id: str | None = None) -> None:
    normalized = name.strip()
    if not normalized:
        return
    query = db.query(Schema).filter(Schema.name == normalized, Schema.ephemeral == False, Schema.archived == False)  # noqa: E712
    if schema_id:
        query = query.filter(Schema.id != schema_id)
    if query.first():
        raise HTTPException(status_code=409, detail=f"Schema name already exists: {normalized}")


def _merge_duplicate_schema_names_into(db: Session, schema: Schema, name: str) -> None:
    normalized = name.strip()
    if not normalized:
        return
    duplicates = (
        db.query(Schema)
        .filter(Schema.name == normalized, Schema.ephemeral == False, Schema.archived == False, Schema.id != schema.id)  # noqa: E712
        .all()
    )
    for duplicate in duplicates:
        db.query(ExtractionJob).filter(ExtractionJob.schema_id == duplicate.id).update(
            {ExtractionJob.schema_id: schema.id},
            synchronize_session=False,
        )
        db.query(Batch).filter(Batch.schema_id == duplicate.id).update(
            {Batch.schema_id: schema.id},
            synchronize_session=False,
        )
        db.query(ExportPreset).filter(ExportPreset.schema_id == duplicate.id).update(
            {ExportPreset.schema_id: schema.id},
            synchronize_session=False,
        )
        log_audit_event(
            db,
            entity_type="schema",
            entity_id=schema.id,
            action="merged_duplicate",
            message=f"Merged duplicate schema {duplicate.id} into {schema.id}",
            metadata={"duplicate_schema_id": duplicate.id, "name": normalized},
        )
        db.delete(duplicate)


def _schema_recommendation_read(payload: dict[str, Any]) -> SchemaRecommendationRead:
    recommendation = SchemaRecommendationRead(**payload)
    seen: set[str] = set()
    unique_fields = []
    for field in recommendation.fields:
        if field.key_name in seen:
            continue
        seen.add(field.key_name)
        unique_fields.append(field)
    return SchemaRecommendationRead(
        name=recommendation.name.strip() or "ai_recommended_schema",
        display_name=recommendation.display_name,
        description=recommendation.description,
        document_type=recommendation.document_type,
        language=recommendation.language,
        reasoning=recommendation.reasoning,
        fields=unique_fields,
    )


def _job_read(job: ExtractionJob) -> ExtractionJobRead:
    return ExtractionJobRead(
        job_id=job.id,
        document_id=job.document_id,
        schema_id=job.schema_id,
        status=job.status,
        error_message=job.error_message,
        result_id=job.result_id,
        result=result_to_dict(job.result) if job.result else None,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


def _batch_read(batch: Batch) -> BatchRead:
    items = [_batch_item_read(item) for item in _sorted_batch_items(batch.items)]
    completed_statuses = {"completed", "needs_review"}
    completed_count = sum(1 for item in items if item.status in completed_statuses)
    failed_count = sum(1 for item in items if item.status == "failed")
    canceled_count = sum(1 for item in items if item.status == "canceled")
    finished_count = completed_count + failed_count + canceled_count
    if batch.total_count and finished_count >= batch.total_count:
        if canceled_count == batch.total_count:
            status = "canceled"
        elif failed_count or canceled_count:
            status = "completed_with_errors"
        else:
            status = "completed"
    elif canceled_count:
        status = "canceling"
    else:
        status = "running"
    progress = finished_count / batch.total_count if batch.total_count else 0
    return BatchRead(
        id=batch.id,
        schema_id=batch.schema_id,
        status=status,
        total_count=batch.total_count,
        completed_count=completed_count,
        failed_count=failed_count,
        canceled_count=canceled_count,
        progress=progress,
        items=items,
        created_at=batch.created_at,
        completed_at=batch.completed_at,
    )


def _batch_item_read(item: BatchItem) -> BatchItemRead:
    return BatchItemRead(
        id=item.id,
        document_id=item.document_id,
        job_id=item.job_id,
        filename=item.filename,
        status=item.job.status if item.job else "unknown",
        result_id=item.job.result_id if item.job else None,
        error_message=item.job.error_message if item.job else None,
        created_at=item.created_at,
    )


def _classification_batch_read(batch: ClassificationBatch) -> ClassificationBatchRead:
    items = [_classification_batch_item_read(item) for item in _sorted_module_items(batch.items)]
    status, completed_count, failed_count, canceled_count, progress = _module_batch_status(batch.total_count, items)
    return ClassificationBatchRead(
        id=batch.id,
        classifier_id=batch.classifier_id,
        status=status,
        total_count=batch.total_count,
        completed_count=completed_count,
        failed_count=failed_count,
        canceled_count=canceled_count,
        progress=progress,
        items=items,
        created_at=batch.created_at,
        completed_at=batch.completed_at,
    )


def _classification_batch_item_read(item: ClassificationBatchItem) -> ClassificationBatchItemRead:
    return ClassificationBatchItemRead(
        id=item.id,
        document_id=item.document_id,
        job_id=item.job_id,
        filename=item.filename,
        status=item.job.status if item.job else "unknown",
        result_id=item.job.result_id if item.job else None,
        error_message=item.job.error_message if item.job else None,
        created_at=item.created_at,
    )


def _required_field_batch_read(batch: RequiredFieldCheckBatch) -> RequiredFieldCheckBatchRead:
    items = [_required_field_batch_item_read(item) for item in _sorted_module_items(batch.items)]
    status, completed_count, failed_count, canceled_count, progress = _module_batch_status(batch.total_count, items)
    return RequiredFieldCheckBatchRead(
        id=batch.id,
        checklist_id=batch.checklist_id,
        status=status,
        total_count=batch.total_count,
        completed_count=completed_count,
        failed_count=failed_count,
        canceled_count=canceled_count,
        progress=progress,
        items=items,
        created_at=batch.created_at,
        completed_at=batch.completed_at,
    )


def _required_field_batch_item_read(item: RequiredFieldCheckBatchItem) -> RequiredFieldCheckBatchItemRead:
    return RequiredFieldCheckBatchItemRead(
        id=item.id,
        document_id=item.document_id,
        job_id=item.job_id,
        filename=item.filename,
        status=item.job.status if item.job else "unknown",
        result_id=item.job.result_id if item.job else None,
        error_message=item.job.error_message if item.job else None,
        created_at=item.created_at,
    )


def _module_batch_status(total_count: int, items: list[Any]) -> tuple[str, int, int, int, float]:
    completed_statuses = {"completed", "needs_review"}
    completed_count = sum(1 for item in items if item.status in completed_statuses)
    failed_count = sum(1 for item in items if item.status == "failed")
    canceled_count = sum(1 for item in items if item.status == "canceled")
    finished_count = completed_count + failed_count + canceled_count
    if total_count and finished_count >= total_count:
        if canceled_count == total_count:
            status = "canceled"
        elif failed_count or canceled_count:
            status = "completed_with_errors"
        else:
            status = "completed"
    elif canceled_count:
        status = "canceling"
    else:
        status = "running"
    progress = finished_count / total_count if total_count else 0
    return status, completed_count, failed_count, canceled_count, progress


def _cancel_module_batch(batch: Any, entity_type: str, db: Session) -> None:
    canceled_count = 0
    now = datetime.utcnow()
    for item in batch.items:
        if item.job and item.job.status in {"queued", "running"}:
            item.job.status = "canceled"
            item.job.error_message = "Canceled by user"
            item.job.completed_at = now
            canceled_count += 1
    if canceled_count:
        _close_batch_if_all_jobs_terminal(batch, now)
        if batch.status not in {"canceled", "completed", "completed_with_errors"}:
            batch.status = "cancel_requested"
        action = "cancel_requested"
        message = f"Cancel requested for {canceled_count} running or queued job(s)"
        metadata = {"canceled_count": canceled_count}
    else:
        action = "cancel_skipped"
        message = "No running or queued batch jobs to cancel"
        metadata = {}
    log_audit_event(db, entity_type=entity_type, entity_id=batch.id, action=action, message=message, metadata=metadata)


def _close_batch_if_all_jobs_terminal(batch: Any, completed_at: datetime) -> None:
    terminal_statuses = {"completed", "needs_review", "failed", "canceled"}
    jobs = [item.job for item in batch.items if item.job]
    if not jobs or any(job.status not in terminal_statuses for job in jobs):
        return
    statuses = [job.status for job in jobs]
    if all(status == "canceled" for status in statuses):
        batch.status = "canceled"
    elif any(status in {"failed", "canceled"} for status in statuses):
        batch.status = "completed_with_errors"
    else:
        batch.status = "completed"
    batch.completed_at = completed_at


def _sorted_batch_items(items) -> list[BatchItem]:
    return sorted(items, key=_batch_item_sort_key)


def _batch_item_sort_key(item: BatchItem) -> tuple[str, str]:
    return (item.filename.casefold(), item.id)


def _sorted_module_items(items) -> list[Any]:
    return sorted(items, key=_module_item_sort_key)


def _module_item_sort_key(item: Any) -> tuple[str, str]:
    return (item.filename.casefold(), item.id)


def _upload_file_sort_key(file: UploadFile) -> tuple[str, str]:
    filename = file.filename or ""
    return (filename.casefold(), filename)


def _validate_upload_file_count(files: list[UploadFile]) -> None:
    limit = get_settings().upload_max_batch_files
    if limit > 0 and len(files) > limit:
        raise HTTPException(status_code=413, detail=f"Batch file count exceeds the configured limit of {limit}")


def _batch_export_row(item: BatchItem, field_names: list[str]) -> dict[str, Any]:
    job = item.job
    row: dict[str, Any] = {
        "filename": item.filename,
        "document_id": item.document_id,
        "job_id": item.job_id,
        "status": job.status if job else "unknown",
        "error_message": job.error_message if job else None,
        "warnings": [],
    }
    for field_name in field_names:
        row[field_name] = None
    if not job or not job.result:
        return row

    output = json.loads(job.result.corrected_output) if job.result.corrected_output else json.loads(job.result.validated_output)
    values = output.get("values", {})
    warnings: list[str] = []
    for field_name in field_names:
        value = values.get(field_name)
        if isinstance(value, dict):
            row[field_name] = value.get("value")
            warnings.extend(str(warning) for warning in value.get("warnings", []))
        else:
            row[field_name] = value
    row["warnings"] = warnings
    return row


def _classification_batch_export_row(item: ClassificationBatchItem) -> dict[str, Any]:
    job = item.job
    row: dict[str, Any] = {
        "filename": item.filename,
        "document_id": item.document_id,
        "job_id": item.job_id,
        "status": job.status if job else "unknown",
        "error_message": job.error_message if job else None,
        "classification_status": None,
        "class_name": None,
        "confidence": None,
        "reason": None,
        "evidence": [],
    }
    if not job or not job.result:
        return row
    output = json.loads(job.result.corrected_output) if job.result.corrected_output else json.loads(job.result.validated_output)
    row["classification_status"] = output.get("status")
    row["class_name"] = output.get("class_name")
    row["confidence"] = output.get("confidence")
    row["reason"] = output.get("reason")
    row["evidence"] = output.get("evidence") if isinstance(output.get("evidence"), list) else []
    return row


def _required_field_batch_export_row(item: RequiredFieldCheckBatchItem, item_names: list[str]) -> dict[str, Any]:
    job = item.job
    row: dict[str, Any] = {
        "filename": item.filename,
        "document_id": item.document_id,
        "job_id": item.job_id,
        "status": job.status if job else "unknown",
        "error_message": job.error_message if job else None,
        "overall_status": None,
    }
    for item_name in item_names:
        row[f"{item_name}_status"] = None
        row[f"{item_name}_evidence"] = None
    if not job or not job.result:
        return row
    output = json.loads(job.result.corrected_output) if job.result.corrected_output else json.loads(job.result.validated_output)
    row["overall_status"] = output.get("overall_status")
    output_items = output.get("items") if isinstance(output.get("items"), list) else []
    by_name = {entry.get("item_name"): entry for entry in output_items if isinstance(entry, dict)}
    for item_name in item_names:
        entry = by_name.get(item_name, {})
        row[f"{item_name}_status"] = entry.get("status")
        row[f"{item_name}_evidence"] = entry.get("evidence")
    return row


def _csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, list):
        return ";".join(str(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return value


def _csv_download_response(content: str, filename: str) -> Response:
    return Response(
        content=f"\ufeff{content}",
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _export_preset_read(preset: ExportPreset) -> ExportPresetRead:
    return ExportPresetRead(
        id=preset.id,
        schema_id=preset.schema_id,
        name=preset.name,
        fields=json.loads(preset.fields_json),
        created_at=preset.created_at,
        updated_at=preset.updated_at,
    )


def _apply_export_preset(payload: dict[str, Any], preset: ExportPreset) -> dict[str, Any]:
    fields = [field for field in json.loads(preset.fields_json) if field.get("include", True)]
    if not fields:
        return payload
    values = payload.get("values", {})
    next_values: dict[str, Any] = {}
    for field in fields:
        key_name = field.get("key_name")
        if not key_name or key_name not in values:
            continue
        output_key = field.get("column_name") or key_name
        next_values[output_key] = values[key_name]
    return {**payload, "values": next_values}


def _archive_search(
    db: Session,
    *,
    q: str | None,
    status: str | None,
    schema_id: str | None,
    document_type: str | None,
    limit: int,
) -> list[ArchiveSearchResult]:
    normalized_q = (q or "").strip().lower()
    documents = db.query(Document).order_by(Document.created_at.desc()).limit(200).all()
    results: list[ArchiveSearchResult] = []
    for document in documents:
        if document_type and document.document_type != document_type:
            continue
        jobs = db.query(ExtractionJob).filter(ExtractionJob.document_id == document.id).order_by(ExtractionJob.created_at.desc()).all()
        if not jobs:
            if status or schema_id:
                continue
            haystack = " ".join(filter(None, [document.filename, document.document_type, document.language])).lower()
            if normalized_q and normalized_q not in haystack:
                continue
            results.append(
                ArchiveSearchResult(
                    document_id=document.id,
                    filename=document.filename,
                    document_type=document.document_type,
                    language=document.language,
                    created_at=document.created_at,
                    matched_text=document.filename,
                )
            )
            if len(results) >= limit:
                return results
            continue

        for job in jobs:
            if status and job.status != status:
                continue
            if schema_id and job.schema_id != schema_id:
                continue
            schema_name = job.schema.name if job.schema else None
            matched_text = _job_search_text(document, job, schema_name)
            if normalized_q and normalized_q not in matched_text.lower():
                continue
            results.append(
                ArchiveSearchResult(
                    document_id=document.id,
                    filename=document.filename,
                    document_type=document.document_type,
                    language=document.language,
                    job_id=job.id,
                    result_id=job.result_id,
                    schema_id=job.schema_id,
                    schema_name=schema_name,
                    status=job.status,
                    matched_text=matched_text[:240],
                    created_at=job.created_at,
                )
            )
            if len(results) >= limit:
                return results
    return results


def _job_search_text(document: Document, job: ExtractionJob, schema_name: str | None) -> str:
    parts = [document.filename, document.document_type or "", document.language or "", schema_name or "", job.status]
    if job.result:
        payload = json.loads(job.result.corrected_output) if job.result.corrected_output else json.loads(job.result.validated_output)
        for key, value in payload.get("values", {}).items():
            parts.append(str(key))
            if isinstance(value, dict):
                parts.append(str(value.get("value", "")))
                parts.append(str(value.get("evidence", "")))
    return " ".join(parts)


def _audit_event_read(event: AuditEvent) -> AuditEventRead:
    return AuditEventRead(
        id=event.id,
        entity_type=event.entity_type,
        entity_id=event.entity_id,
        action=event.action,
        message=event.message,
        metadata=json.loads(event.metadata_json),
        created_at=event.created_at,
    )


def _apply_security_headers(response: Response) -> None:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*",
    )


def _start_retention_cleanup_worker() -> threading.Event | None:
    settings = get_settings()
    retention_hours = settings.resolved_upload_retention_hours
    if retention_hours <= 0:
        return None

    stop_event = threading.Event()

    def _run() -> None:
        while not stop_event.is_set():
            try:
                _cleanup_expired_upload_data()
            except Exception:
                pass
            interval = max(60, int(get_settings().retention_cleanup_interval_seconds or 86400))
            stop_event.wait(interval)

    thread = threading.Thread(target=_run, name="upload-retention-cleanup", daemon=True)
    thread.start()
    return stop_event


def _cleanup_expired_upload_data() -> dict[str, Any]:
    settings = get_settings()
    retention_hours = settings.resolved_upload_retention_hours
    if retention_hours <= 0:
        return {"status": "disabled"}
    cutoff = datetime.utcnow() - timedelta(hours=retention_hours)
    db = SessionLocal()
    try:
        documents = db.query(Document).filter(Document.created_at < cutoff).all()
        raw_rows = db.query(RawExtraction).filter(RawExtraction.created_at < cutoff).all()
        paths = _storage_paths_for_cleanup(documents, raw_rows)
        counts = _delete_history_before(db, cutoff)
        db.commit()
    finally:
        db.close()

    removed_paths: list[str] = []
    for path in paths:
        try:
            delete_storage_ref(path)
            removed_paths.append(str(path))
        except Exception:
            pass
    return {"status": "cleaned", "cutoff": cutoff.isoformat(), "counts": counts, "removed_paths": removed_paths}


def _storage_paths_for_cleanup(documents: list[Document], raw_rows: list[RawExtraction]) -> set[str]:
    paths: set[str] = set()
    for document in documents:
        if document.storage_path:
            paths.add(_artifact_root(document.storage_path))
        for page in document.pages:
            if page.image_path and is_s3_ref(page.image_path):
                paths.add(page.image_path)
    for raw in raw_rows:
        for ref in [raw.storage_path, raw.pdf_path, raw.html_path]:
            if ref:
                paths.add(_artifact_root(ref))
    return paths


def _artifact_root(ref: str) -> str:
    if is_s3_ref(ref):
        return ref
    path = Path(ref)
    return str(path.parent if path.name.startswith(("original", "preview", "content")) else path)


def _delete_history_before(db: Session, cutoff: datetime) -> dict[str, int]:
    counts: dict[str, int] = {}
    expired_document_ids = [row[0] for row in db.query(Document.id).filter(Document.created_at < cutoff).all()]
    expired_extraction_job_ids = [row[0] for row in db.query(ExtractionJob.id).filter(ExtractionJob.created_at < cutoff).all()]
    expired_classification_job_ids = [row[0] for row in db.query(ClassificationJob.id).filter(ClassificationJob.created_at < cutoff).all()]
    expired_required_job_ids = [row[0] for row in db.query(RequiredFieldCheckJob.id).filter(RequiredFieldCheckJob.created_at < cutoff).all()]

    counts["classification_batch_items"] = db.query(ClassificationBatchItem).filter(ClassificationBatchItem.created_at < cutoff).delete(synchronize_session=False)
    counts["classification_batches"] = db.query(ClassificationBatch).filter(ClassificationBatch.created_at < cutoff).delete(synchronize_session=False)
    if expired_classification_job_ids:
        counts["classification_results"] = db.query(ClassificationResult).filter(ClassificationResult.job_id.in_(expired_classification_job_ids)).delete(synchronize_session=False)
    counts["classification_jobs"] = db.query(ClassificationJob).filter(ClassificationJob.created_at < cutoff).delete(synchronize_session=False)

    counts["required_field_check_batch_items"] = db.query(RequiredFieldCheckBatchItem).filter(RequiredFieldCheckBatchItem.created_at < cutoff).delete(synchronize_session=False)
    counts["required_field_check_batches"] = db.query(RequiredFieldCheckBatch).filter(RequiredFieldCheckBatch.created_at < cutoff).delete(synchronize_session=False)
    if expired_required_job_ids:
        counts["required_field_check_results"] = db.query(RequiredFieldCheckResult).filter(RequiredFieldCheckResult.job_id.in_(expired_required_job_ids)).delete(synchronize_session=False)
    counts["required_field_check_jobs"] = db.query(RequiredFieldCheckJob).filter(RequiredFieldCheckJob.created_at < cutoff).delete(synchronize_session=False)

    counts["workflow_run_items"] = db.query(WorkflowRunItem).filter(WorkflowRunItem.created_at < cutoff).delete(synchronize_session=False)
    counts["workflow_runs"] = db.query(WorkflowRun).filter(WorkflowRun.created_at < cutoff).delete(synchronize_session=False)
    counts["batch_items"] = db.query(BatchItem).filter(BatchItem.created_at < cutoff).delete(synchronize_session=False)
    counts["batches"] = db.query(Batch).filter(Batch.created_at < cutoff).delete(synchronize_session=False)
    if expired_extraction_job_ids:
        counts["extraction_results"] = db.query(ExtractionResult).filter(ExtractionResult.job_id.in_(expired_extraction_job_ids)).delete(synchronize_session=False)
    counts["extraction_jobs"] = db.query(ExtractionJob).filter(ExtractionJob.created_at < cutoff).delete(synchronize_session=False)
    if expired_document_ids:
        counts["document_pages"] = db.query(DocumentPage).filter(DocumentPage.document_id.in_(expired_document_ids)).delete(synchronize_session=False)
    counts["documents"] = db.query(Document).filter(Document.created_at < cutoff).delete(synchronize_session=False)
    counts["raw_extractions"] = db.query(RawExtraction).filter(RawExtraction.created_at < cutoff).delete(synchronize_session=False)
    counts["audit_events"] = db.query(AuditEvent).filter(AuditEvent.created_at < cutoff).delete(synchronize_session=False)
    counts["draft_schemas"] = db.query(Schema).filter(Schema.ephemeral == True, Schema.created_at < cutoff).delete(synchronize_session=False)  # noqa: E712
    return counts


def _configure_frontend_static() -> None:
    settings = get_settings()
    if not settings.serve_frontend:
        return

    dist_dir = settings.resolved_frontend_dist_dir
    index_path = dist_dir / "index.html"
    if not index_path.exists():
        return

    assets_dir = dist_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend_assets")

    @app.get("/", include_in_schema=False)
    def _frontend_index() -> FileResponse:
        return FileResponse(index_path)

    @app.get("/{full_path:path}", include_in_schema=False)
    def _frontend_spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        requested = (dist_dir / full_path).resolve()
        if requested.is_file() and _is_relative_to(requested, dist_dir.resolve()):
            return FileResponse(requested)
        return FileResponse(index_path)


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


_configure_frontend_static()
