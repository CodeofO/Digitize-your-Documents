import csv
import errno
import io
import json
import re
import shutil
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.datastructures import FormData
from starlette.exceptions import HTTPException as StarletteHTTPException

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
    BatchInitRequest,
    AuditEventRead,
    BatchItemRead,
    BatchRead,
    ClassificationBatchInitRequest,
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
    RequiredFieldCheckBatchInitRequest,
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
    WorkflowRunEnqueueRequest,
    WorkflowDefinitionCreate,
    WorkflowDefinitionRead,
    WorkflowDefinitionUpdate,
    WorkflowRunInitRequest,
    WorkflowRunRead,
    WorkflowRunRestartRequest,
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

WORKFLOW_RUN_TERMINAL_STATUSES = {"completed", "completed_with_errors", "needs_review", "failed", "canceled"}
WORKFLOW_ENQUEUE_BLOCKED_STATUSES = {"waiting", "failed", "canceled"}

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
    except StarletteHTTPException as exc:
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
        upload_max_batch_files=settings.upload_max_batch_files,
        upload_chunk_files=settings.upload_chunk_files,
        preprocess_max_workers=settings.preprocess_max_workers,
        vlm_max_concurrent_requests=settings.vlm_max_concurrent_requests,
        document_page_max_long_edge=settings.document_page_max_long_edge,
        document_page_jpeg_quality=settings.document_page_jpeg_quality,
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
        vlm_max_concurrent_requests=settings.vlm_max_concurrent_requests,
        kie_field_group_size=settings.kie_field_group_size,
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
        "VLM_MAX_CONCURRENT_REQUESTS": str(payload.vlm_max_concurrent_requests or get_settings().vlm_max_concurrent_requests),
        "KIE_FIELD_GROUP_SIZE": str(payload.kie_field_group_size or get_settings().kie_field_group_size),
    }
    api_key = (payload.api_key or "").strip()
    if api_key:
        updates["VLM_API_KEY"] = api_key

    upsert_root_env(updates, include_defaults=True, remove_keys={"BATCH_MAX_WORKERS", "WORKFLOW_MAX_WORKERS"})
    get_settings.cache_clear()
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
    return FileResponse(path, media_type=_image_media_type(path))


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


@app.post("/api/schemas/{schema_id}/duplicate", response_model=SchemaRead)
def duplicate_schema(schema_id: str, db: Session = Depends(get_db)) -> SchemaRead:
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    if schema.ephemeral:
        raise HTTPException(status_code=400, detail="Draft schemas cannot be duplicated from the library")
    schema_data = _schema_data(schema)
    existing_names = {
        row[0]
        for row in db.query(Schema.name)
        .filter(Schema.ephemeral == False, Schema.archived == False)  # noqa: E712
        .all()
    }
    duplicated_name = _duplicate_name(schema.name, existing_names)
    duplicated_data = {
        **schema_data,
        "name": duplicated_name,
        "display_name": duplicated_name,
    }
    duplicated = Schema(
        name=duplicated_name,
        display_name=duplicated_name,
        description=schema.description,
        current_version=1,
        schema_json=json.dumps(duplicated_data, ensure_ascii=False),
        is_template=schema.is_template,
        template_category=schema.template_category,
        pinned=schema.pinned,
        ephemeral=False,
        archived=False,
    )
    db.add(duplicated)
    db.flush()
    log_audit_event(
        db,
        entity_type="schema",
        entity_id=duplicated.id,
        action="duplicated",
        message=f"Duplicated schema {schema.name} to {duplicated.name}",
        metadata={"source_schema_id": schema.id, "field_count": len(duplicated_data["fields"])},
    )
    db.commit()
    db.refresh(duplicated)
    return _schema_read(duplicated)


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


@app.post("/api/document-classifiers/{classifier_id}/duplicate", response_model=DocumentClassifierRead)
def duplicate_document_classifier(classifier_id: str, db: Session = Depends(get_db)) -> DocumentClassifierRead:
    classifier = db.get(DocumentClassifier, classifier_id)
    if not classifier:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    config = _classifier_data(classifier)
    existing_names = {
        row[0]
        for row in db.query(DocumentClassifier.name)
        .filter(DocumentClassifier.archived == False)  # noqa: E712
        .all()
    }
    duplicated_name = _duplicate_name(classifier.name, existing_names)
    duplicated_config = {
        **config,
        "name": duplicated_name,
    }
    duplicated = DocumentClassifier(
        name=duplicated_name,
        description=classifier.description,
        allow_unknown=classifier.allow_unknown,
        config_json=json.dumps(duplicated_config, ensure_ascii=False),
        archived=False,
    )
    db.add(duplicated)
    db.flush()
    log_audit_event(
        db,
        entity_type="document_classifier",
        entity_id=duplicated.id,
        action="duplicated",
        message=f"Duplicated document classifier {classifier.name} to {duplicated.name}",
        metadata={"source_classifier_id": classifier.id, "class_count": len(duplicated_config["classes"])},
    )
    db.commit()
    db.refresh(duplicated)
    return _classifier_read(duplicated)


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


@app.post("/api/required-field-checklists/{checklist_id}/duplicate", response_model=RequiredFieldChecklistRead)
def duplicate_required_field_checklist(checklist_id: str, db: Session = Depends(get_db)) -> RequiredFieldChecklistRead:
    checklist = db.get(RequiredFieldChecklist, checklist_id)
    if not checklist:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    config = _checklist_data(checklist)
    existing_names = {
        row[0]
        for row in db.query(RequiredFieldChecklist.name)
        .filter(RequiredFieldChecklist.archived == False)  # noqa: E712
        .all()
    }
    duplicated_name = _duplicate_name(checklist.name, existing_names)
    duplicated_config = {
        **config,
        "name": duplicated_name,
    }
    duplicated = RequiredFieldChecklist(
        name=duplicated_name,
        description=checklist.description,
        config_json=json.dumps(duplicated_config, ensure_ascii=False),
        archived=False,
    )
    db.add(duplicated)
    db.flush()
    log_audit_event(
        db,
        entity_type="required_field_checklist",
        entity_id=duplicated.id,
        action="duplicated",
        message=f"Duplicated required field checklist {checklist.name} to {duplicated.name}",
        metadata={"source_checklist_id": checklist.id, "item_count": len(duplicated_config["items"])},
    )
    db.commit()
    db.refresh(duplicated)
    return _checklist_read(duplicated)


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

    job = result.job or db.get(ExtractionJob, result.job_id)
    schema = db.get(Schema, job.schema_id) if job else None
    payload = json.loads(result.corrected_output) if result.corrected_output else json.loads(result.validated_output)
    original_payload = json.loads(result.validated_output)
    reviewed_fields = set(json.loads(result.reviewed_fields or "[]"))
    preset = db.get(ExportPreset, preset_id) if preset_id else None
    if preset_id and not preset:
        raise HTTPException(status_code=404, detail="Export preset not found")
    export_payload = _apply_export_preset(payload, preset) if preset else payload
    original_export_payload = _apply_export_preset(original_payload, preset) if preset else original_payload
    log_audit_event(
        db,
        entity_type="extraction_result",
        entity_id=result.id,
        action="exported",
        message=f"Exported {format.upper()}",
        metadata={"format": format, "preset_id": preset_id},
    )
    db.commit()
    filename = _export_filename("KIE", schema.name if schema else "schema", job.id if job else result_id, format)
    if format == "json":
        return JSONResponse(export_payload, headers=_download_headers(filename))

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=[
            "key_name",
            "value",
            "normalized_value",
            "page",
            "confidence",
            "evidence",
            "warnings",
            "original_value",
            "changed",
            "reviewed",
            "ai_review_enabled",
            "ai_review_status",
            "ai_corrected",
            "ai_review_reason",
            "ai_review_confidence",
            "ai_initial_value",
            "ai_initial_evidence",
            "ai_correction_reason",
        ],
    )
    writer.writeheader()
    original_values = original_export_payload.get("values", {}) if isinstance(original_export_payload.get("values"), dict) else {}
    for key, value in export_payload.get("values", {}).items():
        value_dict = value if isinstance(value, dict) else {}
        original_value = original_values.get(key)
        ai_review = value_dict.get("ai_review") if isinstance(value_dict.get("ai_review"), dict) else {}
        current_cell = _extract_kie_cell_value(value)
        original_cell = _extract_kie_cell_value(original_value) if original_value is not None else current_cell
        writer.writerow(
            {
                "key_name": key,
                "value": current_cell,
                "normalized_value": value_dict.get("normalized_value"),
                "page": value_dict.get("page"),
                "confidence": value_dict.get("confidence"),
                "evidence": value_dict.get("evidence"),
                "warnings": ";".join(value_dict.get("warnings", [])),
                "original_value": original_cell,
                "changed": current_cell != original_cell,
                "reviewed": key in reviewed_fields,
                "ai_review_enabled": bool(ai_review.get("enabled")),
                "ai_review_status": ai_review.get("judgement_status"),
                "ai_corrected": bool(ai_review.get("corrected")),
                "ai_review_reason": ai_review.get("judgement_reason"),
                "ai_review_confidence": ai_review.get("judgement_confidence"),
                "ai_initial_value": ai_review.get("initial_value"),
                "ai_initial_evidence": ai_review.get("initial_evidence"),
                "ai_correction_reason": ai_review.get("correction_reason"),
            }
        )
    return _csv_download_response(output.getvalue(), filename)


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
async def create_workflow_run(
    workflow_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    form, files = await _read_batch_upload_form(request)
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

    run = WorkflowRun(
        workflow_id=workflow.id,
        workflow_name=workflow.name,
        workflow_definition_json=workflow.definition_json,
        status="uploading",
        total_count=len(files),
    )
    db.add(run)
    db.flush()
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="created",
        message=f"Created workflow run with {len(files)} file(s)",
        metadata={"workflow_id": workflow.id, "file_count": len(files)},
    )
    db.commit()
    await _append_workflow_upload_items(run, form, files, db)
    db.refresh(run)
    _validate_owner_can_start(run, run.items)
    now = datetime.utcnow()
    run.execution_generation = (run.execution_generation or 0) + 1
    run.status = "running"
    run.upload_duration_ms = _workflow_upload_duration_ms(run)
    run.inference_started_at = now
    for item in run.items:
        if item.status == "queued":
            item.execution_generation = run.execution_generation
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="started",
        message=f"Started workflow run with {run.total_count} file(s)",
        metadata={"workflow_id": run.workflow_id, "file_count": run.total_count},
    )
    db.commit()
    db.refresh(run)
    response = WorkflowRunRead(**workflow_run_to_read(run))
    execution_generation = run.execution_generation
    db.close()
    background_tasks.add_task(run_workflow_run, run.id, execution_generation)
    return response


@app.post("/api/workflows/{workflow_id}/runs/init", response_model=WorkflowRunRead)
def init_workflow_run(
    workflow_id: str,
    payload: WorkflowRunInitRequest,
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow or workflow.archived:
        raise HTTPException(status_code=404, detail="Workflow not found")
    _validate_declared_batch_file_count(payload.total_count)
    try:
        validate_workflow_definition(json.loads(workflow.definition_json), db)
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors}) from exc

    run = WorkflowRun(
        workflow_id=workflow.id,
        workflow_name=workflow.name,
        workflow_definition_json=workflow.definition_json,
        status="uploading",
        total_count=payload.total_count,
    )
    db.add(run)
    db.flush()
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="upload_initialized",
        message=f"Initialized workflow run upload with {payload.total_count} file(s)",
        metadata={"workflow_id": workflow.id, "file_count": payload.total_count},
    )
    db.commit()
    db.refresh(run)
    return WorkflowRunRead(**workflow_run_to_read(run))


@app.post("/api/workflow-runs/{run_id}/items", response_model=WorkflowRunRead)
async def append_workflow_run_items(
    run_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    form, files = await _read_batch_upload_form(request)
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if run.status == "paused" and len(run.items) < run.total_count:
        run.status = "uploading"
        run.error_message = None
        db.flush()
    if run.status not in {"uploading", "queued"}:
        raise HTTPException(status_code=409, detail="Workflow run already started")
    await _append_workflow_upload_items(run, form, files, db)
    db.refresh(run)
    return WorkflowRunRead(**workflow_run_to_read(run))


@app.post("/api/workflow-runs/{run_id}/start", response_model=WorkflowRunRead)
def start_workflow_run(
    run_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if run.status not in {"uploading", "queued", "waiting"}:
        return WorkflowRunRead(**workflow_run_to_read(run))
    if run.status == "waiting":
        _validate_waiting_workflow_run_can_start(run, db)
    _validate_owner_can_start(run, run.items)
    now = datetime.utcnow()
    run.execution_generation = (run.execution_generation or 0) + 1
    run.status = "running"
    run.upload_duration_ms = _workflow_upload_duration_ms(run)
    run.inference_started_at = now
    for item in run.items:
        if item.status in {"queued", "paused"}:
            item.status = "queued"
            item.error_message = None
            item.completed_at = None
            item.execution_generation = run.execution_generation
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="started",
        message=f"Started workflow run with {run.total_count} file(s)",
        metadata={"workflow_id": run.workflow_id, "file_count": run.total_count},
    )
    db.commit()
    db.refresh(run)
    response = WorkflowRunRead(**workflow_run_to_read(run))
    background_tasks.add_task(run_workflow_run, run.id, run.execution_generation)
    return response


@app.post("/api/workflow-runs/{run_id}/enqueue", response_model=WorkflowRunRead)
def enqueue_workflow_run(
    run_id: str,
    payload: WorkflowRunEnqueueRequest | None = Body(default=None),
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    source_run = db.get(WorkflowRun, run_id)
    if not source_run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if not source_run.items:
        raise HTTPException(status_code=422, detail="No uploaded workflow items are available to enqueue")
    _validate_workflow_enqueue_source(source_run)
    workflow_id = payload.workflow_id if payload and payload.workflow_id else source_run.workflow_id
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow or workflow.archived:
        raise HTTPException(status_code=404, detail="Workflow not found")
    try:
        validate_workflow_definition(json.loads(workflow.definition_json), db)
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors}) from exc

    _validate_owner_can_start(source_run, source_run.items)
    now = datetime.utcnow()
    new_run, queued_count = _create_waiting_workflow_run(source_run, workflow, now, db)
    if not queued_count:
        new_run.status = "completed_with_errors"
        new_run.completed_at = now
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=new_run.id,
        action="queued",
        message=f"Queued workflow run after {source_run.id}",
        metadata={
            "workflow_id": new_run.workflow_id,
            "source_run_id": source_run.id,
            "queue_group_id": new_run.workflow_run_group_id,
            "queue_order": new_run.queue_order,
            "queued_count": queued_count,
        },
    )
    db.commit()
    db.refresh(new_run)
    return WorkflowRunRead(**workflow_run_to_read(new_run))


@app.post("/api/workflow-runs/{run_id}/cancel-waiting", response_model=WorkflowRunRead)
def cancel_waiting_workflow_run(run_id: str, db: Session = Depends(get_db)) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if run.status != "waiting":
        raise HTTPException(status_code=409, detail="Workflow run is not waiting in the queue")
    _cancel_waiting_workflow_run(run, db)
    db.commit()
    db.refresh(run)
    return WorkflowRunRead(**workflow_run_to_read(run))


@app.post("/api/workflow-runs/{run_id}/discard", response_model=WorkflowRunRead)
def discard_workflow_run(run_id: str, db: Session = Depends(get_db)) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    document_ids = [item.document_id for item in run.items]
    if run.status == "waiting":
        _cancel_waiting_workflow_run(run, db)
        db.commit()
        db.refresh(run)
        return WorkflowRunRead(**workflow_run_to_read(run))
    item_count = len(run.items)
    deletable_document_ids = _unshared_workflow_document_ids(run, document_ids, db)
    for item in list(run.items):
        db.delete(item)
    _delete_document_payloads(deletable_document_ids, db)
    run.status = "canceled"
    run.error_message = "Stopped and discarded uploaded payloads"
    run.completed_at = datetime.utcnow()
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="discarded",
        message=f"Discarded workflow run payloads for {item_count} item(s)",
        metadata={"workflow_id": run.workflow_id, "discarded_count": item_count},
    )
    db.commit()
    db.refresh(run)
    return WorkflowRunRead(**workflow_run_to_read(run))


@app.post("/api/workflow-runs/{run_id}/resume", response_model=WorkflowRunRead)
def resume_workflow_run(
    run_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if run.status in {"completed", "completed_with_errors", "needs_review", "failed", "canceled"}:
        raise HTTPException(status_code=409, detail="Workflow run is already terminal")
    if not run.items:
        raise HTTPException(status_code=422, detail="No uploaded workflow items are available to continue")
    _validate_owner_upload_complete(run, run.items)
    resumed_count = _prepare_workflow_run_resume(run)
    run.status = "running" if resumed_count else workflow_run_to_read(run)["status"]
    run.completed_at = None if resumed_count else run.completed_at
    if resumed_count:
        run.execution_generation = (run.execution_generation or 0) + 1
        run.inference_started_at = datetime.utcnow()
        for item in run.items:
            if item.status == "queued":
                item.execution_generation = run.execution_generation
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="resumed",
        message=f"Continued workflow run with {resumed_count} queued item(s)",
        metadata={"workflow_id": run.workflow_id, "queued_count": resumed_count},
    )
    db.commit()
    db.refresh(run)
    response = WorkflowRunRead(**workflow_run_to_read(run))
    if resumed_count:
        background_tasks.add_task(run_workflow_run, run.id, run.execution_generation)
    return response


@app.post("/api/workflow-runs/{run_id}/pause", response_model=WorkflowRunRead)
def pause_workflow_run(run_id: str, db: Session = Depends(get_db)) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if run.status in {"completed", "completed_with_errors", "needs_review", "failed", "canceled"}:
        raise HTTPException(status_code=409, detail="Workflow run is already terminal")
    if run.status == "paused":
        return WorkflowRunRead(**workflow_run_to_read(run))

    paused_count = 0
    now = datetime.utcnow()
    run.execution_generation = (run.execution_generation or 0) + 1
    for item in run.items:
        if item.status in {"queued", "preprocessing", "running"}:
            item.status = "paused"
            item.error_message = "Paused by user"
            item.completed_at = now
            paused_count += 1
    run.status = "paused"
    run.completed_at = None
    run.error_message = "Paused by user"
    _accumulate_workflow_run_inference_duration(run, now)
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="paused",
        message=f"Paused workflow run; {paused_count} active item(s) held",
        metadata={"workflow_id": run.workflow_id, "paused_count": paused_count},
    )
    db.commit()
    db.refresh(run)
    return WorkflowRunRead(**workflow_run_to_read(run))


@app.post("/api/workflow-runs/{run_id}/restart", response_model=WorkflowRunRead)
def restart_workflow_run(
    run_id: str,
    background_tasks: BackgroundTasks,
    payload: WorkflowRunRestartRequest | None = Body(default=None),
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if not run.items:
        raise HTTPException(status_code=422, detail="No uploaded workflow items are available to restart")
    workflow_id = payload.workflow_id if payload and payload.workflow_id else run.workflow_id
    workflow = db.get(WorkflowDefinition, workflow_id)
    if not workflow or workflow.archived:
        raise HTTPException(status_code=404, detail="Workflow not found")
    try:
        validate_workflow_definition(json.loads(workflow.definition_json), db)
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors}) from exc

    sealed_missing_count = _seal_missing_workflow_upload_items(run, db)
    if sealed_missing_count:
        db.flush()
        db.expire(run, ["items"])
    _validate_owner_upload_complete(run, run.items)
    now = datetime.utcnow()
    if run.status not in {"completed", "completed_with_errors", "needs_review", "failed", "canceled"}:
        _accumulate_workflow_run_inference_duration(run, now)
        run.execution_generation = (run.execution_generation or 0) + 1
        run.status = "canceled"
        run.error_message = "Replaced by restarted workflow run"
        run.completed_at = now
    new_run, queued_count = _create_restarted_workflow_run(run, workflow, now, db)
    if not queued_count:
        new_run.status = "completed_with_errors"
        new_run.completed_at = now
        new_run.inference_started_at = None
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=new_run.id,
        action="restarted",
        message=f"Created restarted workflow run with {queued_count} queued item(s)",
        metadata={
            "workflow_id": new_run.workflow_id,
            "source_run_id": run.id,
            "queued_count": queued_count,
            "sealed_missing_count": sealed_missing_count,
        },
    )
    db.commit()
    db.refresh(new_run)
    response = WorkflowRunRead(**workflow_run_to_read(new_run))
    if queued_count:
        background_tasks.add_task(run_workflow_run, new_run.id, new_run.execution_generation)
    return response


@app.post("/api/workflow-runs/{run_id}/retry-failed", response_model=WorkflowRunRead)
def retry_failed_workflow_run(
    run_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if run.status == "canceled":
        raise HTTPException(status_code=409, detail="Canceled workflow run cannot retry failed items")
    blocking_statuses = {"uploading", "preprocessing", "queued", "running", "paused"}
    blocking_count = sum(1 for item in run.items if item.status in blocking_statuses)
    if blocking_count:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Failed items can be retried after active or paused items are finished.",
                "blocking_count": blocking_count,
            },
        )
    failed_count = sum(1 for item in run.items if item.status == "failed")
    if not failed_count:
        raise HTTPException(status_code=422, detail="No failed workflow items are available to retry")

    now = datetime.utcnow()
    _accumulate_workflow_run_inference_duration(run, now)
    run.execution_generation = (run.execution_generation or 0) + 1
    queued_count = _prepare_workflow_run_retry_failed(run)
    if not queued_count:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "No failed workflow items can be retried because their documents are not ready.",
                "failed_count": failed_count,
            },
        )
    run.status = "running"
    run.completed_at = None
    run.error_message = None
    run.inference_started_at = now
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="retry_failed",
        message=f"Retried {queued_count} failed workflow item(s)",
        metadata={"workflow_id": run.workflow_id, "queued_count": queued_count, "failed_count": failed_count},
    )
    db.commit()
    db.refresh(run)
    response = WorkflowRunRead(**workflow_run_to_read(run))
    background_tasks.add_task(run_workflow_run, run.id, run.execution_generation)
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


@app.get("/api/workflow-runs/{run_id}/summary", response_model=WorkflowRunRead)
def get_workflow_run_summary(run_id: str, db: Session = Depends(get_db)) -> WorkflowRunRead:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    return WorkflowRunRead(**workflow_run_to_read(run, include_items=False))


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
    workflow_name = payload.get("workflow_name") or (run.workflow.name if run.workflow else "workflow")
    filename = _export_filename("workflow", workflow_name, run.id, format)
    if format == "json":
        return JSONResponse(payload, headers=_download_headers(filename))
    return _csv_download_response(workflow_run_export_csv(run), filename)


@app.post("/api/batches", response_model=BatchRead)
async def create_batch(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> BatchRead:
    form, files = await _read_batch_upload_form(request)
    schema_id = _required_form_value(form, "schema_id")
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)

    batch = Batch(schema_id=schema.id, schema_version=1, status="uploading", total_count=len(files))
    db.add(batch)
    db.flush()
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="created",
        message=f"Created batch with {len(files)} file(s)",
        metadata={"schema_id": schema.id, "file_count": len(files)},
    )
    db.commit()
    await _append_extraction_batch_items(batch, form, files, db)
    db.refresh(batch)
    _validate_owner_can_start(batch, batch.items)
    batch.status = "running"
    job_ids = _queued_extraction_job_ids(batch)
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="started",
        message=f"Started batch with {len(job_ids)} queued job(s)",
        metadata={"schema_id": schema.id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _batch_read(batch)
    db.close()
    background_tasks.add_task(run_batch_jobs, batch.id, job_ids)
    return response


@app.post("/api/batches/init", response_model=BatchRead)
def init_batch(payload: BatchInitRequest, db: Session = Depends(get_db)) -> BatchRead:
    schema = db.get(Schema, payload.schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    _validate_declared_batch_file_count(payload.total_count)
    batch = Batch(schema_id=schema.id, schema_version=1, status="uploading", total_count=payload.total_count)
    db.add(batch)
    db.flush()
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="upload_initialized",
        message=f"Initialized batch upload with {payload.total_count} file(s)",
        metadata={"schema_id": schema.id, "file_count": payload.total_count},
    )
    db.commit()
    db.refresh(batch)
    return _batch_read(batch)


@app.post("/api/batches/{batch_id}/items", response_model=BatchRead)
async def append_batch_items(batch_id: str, request: Request, db: Session = Depends(get_db)) -> BatchRead:
    form, files = await _read_batch_upload_form(request)
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    if batch.status not in {"uploading", "queued"}:
        raise HTTPException(status_code=409, detail="Batch already started")
    await _append_extraction_batch_items(batch, form, files, db)
    db.refresh(batch)
    return _batch_read(batch)


@app.post("/api/batches/{batch_id}/start", response_model=BatchRead)
def start_batch(batch_id: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> BatchRead:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    if batch.status not in {"uploading", "queued"}:
        return _batch_read(batch)
    _validate_owner_can_start(batch, batch.items)
    batch.status = "running"
    job_ids = _queued_extraction_job_ids(batch)
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="started",
        message=f"Started batch with {len(job_ids)} queued job(s)",
        metadata={"schema_id": batch.schema_id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _batch_read(batch)
    db.close()
    background_tasks.add_task(run_batch_jobs, batch.id, job_ids)
    return response


@app.post("/api/batches/{batch_id}/discard", response_model=BatchRead)
def discard_batch(batch_id: str, db: Session = Depends(get_db)) -> BatchRead:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    discarded_count = _discard_batch_items(batch, db)
    batch.status = "canceled"
    batch.completed_at = datetime.utcnow()
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="discarded",
        message=f"Discarded batch payloads for {discarded_count} item(s)",
        metadata={"schema_id": batch.schema_id, "discarded_count": discarded_count},
    )
    db.commit()
    db.refresh(batch)
    return _batch_read(batch)


@app.post("/api/batches/{batch_id}/resume", response_model=BatchRead)
def resume_batch(batch_id: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> BatchRead:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    if batch.status in {"completed", "completed_with_errors", "failed", "canceled"}:
        raise HTTPException(status_code=409, detail="Batch is already terminal")
    if not batch.items:
        raise HTTPException(status_code=422, detail="No uploaded batch items are available to continue")
    _validate_owner_upload_complete(batch, batch.items)
    _prepare_job_batch_resume(batch.items)
    job_ids = _queued_extraction_job_ids(batch)
    batch.status = "running" if job_ids else _batch_read(batch).status
    batch.completed_at = None if job_ids else batch.completed_at
    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="resumed",
        message=f"Continued batch with {len(job_ids)} queued job(s)",
        metadata={"schema_id": batch.schema_id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _batch_read(batch)
    if job_ids:
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


@app.get("/api/batches/{batch_id}/summary", response_model=BatchRead)
def get_batch_summary(batch_id: str, db: Session = Depends(get_db)) -> BatchRead:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    return _batch_read(batch, include_items=False)


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
        "schema_name": schema.name,
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

    filename = _export_filename("KIE", schema.name, batch.id, format)
    if format == "json":
        return JSONResponse(
            payload,
            headers=_download_headers(filename),
        )

    output = io.StringIO()
    field_columns = [column for field_name in field_names for column in _kie_export_columns(field_name)]
    fieldnames = [
        "filename",
        "document_id",
        "job_id",
        "status",
        "error_message",
        *field_columns,
        "warnings",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_cell(row.get(key)) for key in fieldnames})

    return _csv_download_response(output.getvalue(), filename)


@app.post("/api/classification-batches", response_model=ClassificationBatchRead)
async def create_classification_batch(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> ClassificationBatchRead:
    form, files = await _read_batch_upload_form(request)
    classifier_id = _required_form_value(form, "classifier_id")
    classifier = db.get(DocumentClassifier, classifier_id)
    if not classifier or classifier.archived:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)

    batch = ClassificationBatch(classifier_id=classifier.id, status="uploading", total_count=len(files))
    db.add(batch)
    db.flush()
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="created",
        message=f"Created classification batch with {len(files)} file(s)",
        metadata={"classifier_id": classifier.id, "file_count": len(files)},
    )
    db.commit()
    await _append_classification_batch_items(batch, form, files, db)
    db.refresh(batch)
    _validate_owner_can_start(batch, batch.items)
    batch.status = "running"
    job_ids = _queued_classification_job_ids(batch)
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="started",
        message=f"Started classification batch with {len(job_ids)} queued job(s)",
        metadata={"classifier_id": classifier.id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _classification_batch_read(batch)
    db.close()
    background_tasks.add_task(run_classification_batch, batch.id, job_ids)
    return response


@app.post("/api/classification-batches/init", response_model=ClassificationBatchRead)
def init_classification_batch(payload: ClassificationBatchInitRequest, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    classifier = db.get(DocumentClassifier, payload.classifier_id)
    if not classifier or classifier.archived:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    _validate_declared_batch_file_count(payload.total_count)
    batch = ClassificationBatch(classifier_id=classifier.id, status="uploading", total_count=payload.total_count)
    db.add(batch)
    db.flush()
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="upload_initialized",
        message=f"Initialized classification batch upload with {payload.total_count} file(s)",
        metadata={"classifier_id": classifier.id, "file_count": payload.total_count},
    )
    db.commit()
    db.refresh(batch)
    return _classification_batch_read(batch)


@app.post("/api/classification-batches/{batch_id}/items", response_model=ClassificationBatchRead)
async def append_classification_batch_items(batch_id: str, request: Request, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    form, files = await _read_batch_upload_form(request)
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    if batch.status not in {"uploading", "queued"}:
        raise HTTPException(status_code=409, detail="Classification batch already started")
    await _append_classification_batch_items(batch, form, files, db)
    db.refresh(batch)
    return _classification_batch_read(batch)


@app.post("/api/classification-batches/{batch_id}/start", response_model=ClassificationBatchRead)
def start_classification_batch(batch_id: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    if batch.status not in {"uploading", "queued"}:
        return _classification_batch_read(batch)
    _validate_owner_can_start(batch, batch.items)
    batch.status = "running"
    job_ids = _queued_classification_job_ids(batch)
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="started",
        message=f"Started classification batch with {len(job_ids)} queued job(s)",
        metadata={"classifier_id": batch.classifier_id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _classification_batch_read(batch)
    db.close()
    background_tasks.add_task(run_classification_batch, batch.id, job_ids)
    return response


@app.post("/api/classification-batches/{batch_id}/discard", response_model=ClassificationBatchRead)
def discard_classification_batch(batch_id: str, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    discarded_count = _discard_batch_items(batch, db)
    batch.status = "canceled"
    batch.completed_at = datetime.utcnow()
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="discarded",
        message=f"Discarded classification batch payloads for {discarded_count} item(s)",
        metadata={"classifier_id": batch.classifier_id, "discarded_count": discarded_count},
    )
    db.commit()
    db.refresh(batch)
    return _classification_batch_read(batch)


@app.post("/api/classification-batches/{batch_id}/resume", response_model=ClassificationBatchRead)
def resume_classification_batch(
    batch_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> ClassificationBatchRead:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    if batch.status in {"completed", "completed_with_errors", "failed", "canceled"}:
        raise HTTPException(status_code=409, detail="Classification batch is already terminal")
    if not batch.items:
        raise HTTPException(status_code=422, detail="No uploaded classification items are available to continue")
    _validate_owner_upload_complete(batch, batch.items)
    _prepare_job_batch_resume(batch.items)
    job_ids = _queued_classification_job_ids(batch)
    batch.status = "running" if job_ids else _classification_batch_read(batch).status
    batch.completed_at = None if job_ids else batch.completed_at
    log_audit_event(
        db,
        entity_type="classification_batch",
        entity_id=batch.id,
        action="resumed",
        message=f"Continued classification batch with {len(job_ids)} queued job(s)",
        metadata={"classifier_id": batch.classifier_id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _classification_batch_read(batch)
    if job_ids:
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


@app.get("/api/classification-batches/{batch_id}/summary", response_model=ClassificationBatchRead)
def get_classification_batch_summary(batch_id: str, db: Session = Depends(get_db)) -> ClassificationBatchRead:
    batch = db.get(ClassificationBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Classification batch not found")
    return _classification_batch_read(batch, include_items=False)


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
    classifier = db.get(DocumentClassifier, batch.classifier_id)
    if not classifier:
        raise HTTPException(status_code=404, detail="Document classifier not found")
    rows = [_classification_batch_export_row(item) for item in _sorted_module_items(batch.items)]
    payload = {
        "batch_id": batch.id,
        "classifier_id": batch.classifier_id,
        "classifier_name": classifier.name,
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
    filename = _export_filename("classification", classifier.name, batch.id, format)
    if format == "json":
        return JSONResponse(payload, headers=_download_headers(filename))

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
    return _csv_download_response(output.getvalue(), filename)


@app.post("/api/required-field-check-batches", response_model=RequiredFieldCheckBatchRead)
async def create_required_field_check_batch(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckBatchRead:
    form, files = await _read_batch_upload_form(request)
    checklist_id = _required_form_value(form, "checklist_id")
    checklist = db.get(RequiredFieldChecklist, checklist_id)
    if not checklist or checklist.archived:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)

    batch = RequiredFieldCheckBatch(checklist_id=checklist.id, status="uploading", total_count=len(files))
    db.add(batch)
    db.flush()
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="created",
        message=f"Created required field check batch with {len(files)} file(s)",
        metadata={"checklist_id": checklist.id, "file_count": len(files)},
    )
    db.commit()
    await _append_required_field_batch_items(batch, form, files, db)
    db.refresh(batch)
    _validate_owner_can_start(batch, batch.items)
    batch.status = "running"
    job_ids = _queued_required_field_job_ids(batch)
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="started",
        message=f"Started required field check batch with {len(job_ids)} queued job(s)",
        metadata={"checklist_id": checklist.id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _required_field_batch_read(batch)
    db.close()
    background_tasks.add_task(run_required_field_check_batch, batch.id, job_ids)
    return response


@app.post("/api/required-field-check-batches/init", response_model=RequiredFieldCheckBatchRead)
def init_required_field_check_batch(
    payload: RequiredFieldCheckBatchInitRequest,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckBatchRead:
    checklist = db.get(RequiredFieldChecklist, payload.checklist_id)
    if not checklist or checklist.archived:
        raise HTTPException(status_code=404, detail="Required field checklist not found")
    _validate_declared_batch_file_count(payload.total_count)
    batch = RequiredFieldCheckBatch(checklist_id=checklist.id, status="uploading", total_count=payload.total_count)
    db.add(batch)
    db.flush()
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="upload_initialized",
        message=f"Initialized required field check batch upload with {payload.total_count} file(s)",
        metadata={"checklist_id": checklist.id, "file_count": payload.total_count},
    )
    db.commit()
    db.refresh(batch)
    return _required_field_batch_read(batch)


@app.post("/api/required-field-check-batches/{batch_id}/items", response_model=RequiredFieldCheckBatchRead)
async def append_required_field_check_batch_items(
    batch_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckBatchRead:
    form, files = await _read_batch_upload_form(request)
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    if batch.status not in {"uploading", "queued"}:
        raise HTTPException(status_code=409, detail="Required field check batch already started")
    await _append_required_field_batch_items(batch, form, files, db)
    db.refresh(batch)
    return _required_field_batch_read(batch)


@app.post("/api/required-field-check-batches/{batch_id}/start", response_model=RequiredFieldCheckBatchRead)
def start_required_field_check_batch(
    batch_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckBatchRead:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    if batch.status not in {"uploading", "queued"}:
        return _required_field_batch_read(batch)
    _validate_owner_can_start(batch, batch.items)
    batch.status = "running"
    job_ids = _queued_required_field_job_ids(batch)
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="started",
        message=f"Started required field check batch with {len(job_ids)} queued job(s)",
        metadata={"checklist_id": batch.checklist_id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _required_field_batch_read(batch)
    db.close()
    background_tasks.add_task(run_required_field_check_batch, batch.id, job_ids)
    return response


@app.post("/api/required-field-check-batches/{batch_id}/discard", response_model=RequiredFieldCheckBatchRead)
def discard_required_field_check_batch(batch_id: str, db: Session = Depends(get_db)) -> RequiredFieldCheckBatchRead:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    discarded_count = _discard_batch_items(batch, db)
    batch.status = "canceled"
    batch.completed_at = datetime.utcnow()
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="discarded",
        message=f"Discarded required field check batch payloads for {discarded_count} item(s)",
        metadata={"checklist_id": batch.checklist_id, "discarded_count": discarded_count},
    )
    db.commit()
    db.refresh(batch)
    return _required_field_batch_read(batch)


@app.post("/api/required-field-check-batches/{batch_id}/resume", response_model=RequiredFieldCheckBatchRead)
def resume_required_field_check_batch(
    batch_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> RequiredFieldCheckBatchRead:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    if batch.status in {"completed", "completed_with_errors", "failed", "canceled"}:
        raise HTTPException(status_code=409, detail="Required field check batch is already terminal")
    if not batch.items:
        raise HTTPException(status_code=422, detail="No uploaded required field items are available to continue")
    _validate_owner_upload_complete(batch, batch.items)
    _prepare_job_batch_resume(batch.items)
    job_ids = _queued_required_field_job_ids(batch)
    batch.status = "running" if job_ids else _required_field_batch_read(batch).status
    batch.completed_at = None if job_ids else batch.completed_at
    log_audit_event(
        db,
        entity_type="required_field_check_batch",
        entity_id=batch.id,
        action="resumed",
        message=f"Continued required field check batch with {len(job_ids)} queued job(s)",
        metadata={"checklist_id": batch.checklist_id, "queued_count": len(job_ids)},
    )
    db.commit()
    db.refresh(batch)
    response = _required_field_batch_read(batch)
    if job_ids:
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


@app.get("/api/required-field-check-batches/{batch_id}/summary", response_model=RequiredFieldCheckBatchRead)
def get_required_field_check_batch_summary(batch_id: str, db: Session = Depends(get_db)) -> RequiredFieldCheckBatchRead:
    batch = db.get(RequiredFieldCheckBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Required field check batch not found")
    return _required_field_batch_read(batch, include_items=False)


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
        "checklist_name": checklist.name,
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
    filename = _export_filename("required_checker", checklist.name, batch.id, format)
    if format == "json":
        return JSONResponse(payload, headers=_download_headers(filename))

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
    return _csv_download_response(output.getvalue(), filename)


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
        error_message=document.error_message,
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
        page.image_path = persist_artifact(image_path, f"documents/{document.id}/pages/{image_path.name}", _image_media_type(image_path))
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
        document, original_path = _create_uploaded_document(file, db)
        _preprocess_document_pages(document, original_path, db)
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Failed to process uploaded document") from exc
    return document


def _persist_document_artifacts(original_path: Path, pages: list[dict[str, int | str]]) -> tuple[str, list[dict[str, int | str]]]:
    settings = get_settings()
    if settings.storage_backend.strip().lower() != "s3":
        return str(original_path), pages
    document_key = original_path.parent.name
    original_ref = _persist_original_artifact(original_path)
    return original_ref, _persist_document_pages(document_key, pages)


def _create_uploaded_document(file: UploadFile, db: Session) -> tuple[Document, Path]:
    filename, original_path, size_bytes = save_upload_file(file)
    document = Document(
        filename=filename,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=size_bytes,
        page_count=0,
        storage_path=_persist_original_artifact(original_path),
        status="preprocessing",
    )
    db.add(document)
    db.flush()
    return document, original_path


def _create_failed_upload_document(file: UploadFile, message: str, db: Session) -> Document:
    return _create_failed_upload_document_record(file.filename or "upload", file.content_type or "application/octet-stream", message, db)


def _create_failed_upload_document_record(filename: str, mime_type: str, message: str, db: Session) -> Document:
    document = Document(
        filename=filename,
        mime_type=mime_type,
        size_bytes=0,
        page_count=0,
        storage_path="",
        status="failed",
        error_message=message,
    )
    db.add(document)
    db.flush()
    return document


def _preprocess_document_pages(document: Document, original_path: Path, db: Session, *, raise_errors: bool = True) -> bool:
    try:
        pages = rasterize_document(original_path)
        pages = _persist_document_pages(original_path.parent.name, pages)
    except DocumentProcessingError as exc:
        document.status = "failed"
        document.error_message = str(exc)
        if raise_errors:
            raise
        return False
    except Exception as exc:
        document.status = "failed"
        document.error_message = "Failed to process uploaded document"
        if raise_errors:
            raise DocumentProcessingError("Failed to process uploaded document") from exc
        return False

    for existing in list(document.pages):
        db.delete(existing)
    db.flush()
    persisted_pages: list[dict[str, int | str]] = []
    for page in pages:
        image_path = Path(str(page["image_path"]))
        persisted_pages.append({**page, "image_path": str(image_path)})
        db.add(
            DocumentPage(
                document_id=document.id,
                page_number=int(page["page_number"]),
                image_path=str(page["image_path"]),
                width=int(page["width"]),
                height=int(page["height"]),
            )
        )
    document.page_count = len(persisted_pages)
    document.status = "ready"
    document.error_message = None
    return True


def _persist_original_artifact(original_path: Path) -> str:
    if get_settings().storage_backend.strip().lower() != "s3":
        return str(original_path)
    document_key = original_path.parent.name
    return persist_artifact(original_path, f"documents/{document_key}/original{original_path.suffix}")


def _persist_document_pages(document_key: str, pages: list[dict[str, int | str]]) -> list[dict[str, int | str]]:
    if get_settings().storage_backend.strip().lower() != "s3":
        return pages
    persisted_pages: list[dict[str, int | str]] = []
    for page in pages:
        image_path = Path(str(page["image_path"]))
        page_ref = persist_artifact(image_path, f"documents/{document_key}/pages/{image_path.name}", _image_media_type(image_path))
        persisted_pages.append({**page, "image_path": page_ref})
    return persisted_pages


def _image_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    return "application/octet-stream"


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


def _duplicate_name(name: str, existing_names: set[str], max_length: int = 120) -> str:
    base = name.strip() or "schema"
    for index in range(1, 10000):
        suffix = f" ({index})"
        truncated_base = base[: max(1, max_length - len(suffix))].rstrip()
        candidate = f"{truncated_base}{suffix}"
        if candidate not in existing_names:
            return candidate
    raise HTTPException(status_code=409, detail=f"Could not create a duplicate name for: {base}")


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


def _batch_read(batch: Batch, *, include_items: bool = True) -> BatchRead:
    items = [_batch_item_read(item) for item in _sorted_batch_items(batch.items)]
    counters = _owner_counters(batch.total_count, [item.status for item in items], batch.status)
    return BatchRead(
        id=batch.id,
        schema_id=batch.schema_id,
        status=counters["status"],
        total_count=batch.total_count,
        completed_count=counters["completed_count"],
        failed_count=counters["failed_count"],
        canceled_count=counters["canceled_count"],
        uploaded_count=counters["uploaded_count"],
        preprocessing_count=counters["preprocessing_count"],
        ready_count=counters["ready_count"],
        queued_count=counters["queued_count"],
        running_count=counters["running_count"],
        needs_review_count=counters["needs_review_count"],
        progress_phase=counters["progress_phase"],
        progress=counters["progress"],
        items=items if include_items else [],
        created_at=batch.created_at,
        completed_at=batch.completed_at,
    )


def _batch_item_read(item: BatchItem) -> BatchItemRead:
    return BatchItemRead(
        id=item.id,
        document_id=item.document_id,
        job_id=item.job_id,
        filename=item.filename,
        upload_index=item.upload_index,
        status=item.job.status if item.job else "unknown",
        result_id=item.job.result_id if item.job else None,
        error_message=item.job.error_message if item.job else None,
        created_at=item.created_at,
    )


def _classification_batch_read(batch: ClassificationBatch, *, include_items: bool = True) -> ClassificationBatchRead:
    items = [_classification_batch_item_read(item) for item in _sorted_module_items(batch.items)]
    counters = _owner_counters(batch.total_count, [item.status for item in items], batch.status)
    return ClassificationBatchRead(
        id=batch.id,
        classifier_id=batch.classifier_id,
        status=counters["status"],
        total_count=batch.total_count,
        completed_count=counters["completed_count"],
        failed_count=counters["failed_count"],
        canceled_count=counters["canceled_count"],
        uploaded_count=counters["uploaded_count"],
        preprocessing_count=counters["preprocessing_count"],
        ready_count=counters["ready_count"],
        queued_count=counters["queued_count"],
        running_count=counters["running_count"],
        needs_review_count=counters["needs_review_count"],
        progress_phase=counters["progress_phase"],
        progress=counters["progress"],
        items=items if include_items else [],
        created_at=batch.created_at,
        completed_at=batch.completed_at,
    )


def _classification_batch_item_read(item: ClassificationBatchItem) -> ClassificationBatchItemRead:
    return ClassificationBatchItemRead(
        id=item.id,
        document_id=item.document_id,
        job_id=item.job_id,
        filename=item.filename,
        upload_index=item.upload_index,
        status=item.job.status if item.job else "unknown",
        result_id=item.job.result_id if item.job else None,
        error_message=item.job.error_message if item.job else None,
        created_at=item.created_at,
    )


def _required_field_batch_read(batch: RequiredFieldCheckBatch, *, include_items: bool = True) -> RequiredFieldCheckBatchRead:
    items = [_required_field_batch_item_read(item) for item in _sorted_module_items(batch.items)]
    counters = _owner_counters(batch.total_count, [item.status for item in items], batch.status)
    return RequiredFieldCheckBatchRead(
        id=batch.id,
        checklist_id=batch.checklist_id,
        status=counters["status"],
        total_count=batch.total_count,
        completed_count=counters["completed_count"],
        failed_count=counters["failed_count"],
        canceled_count=counters["canceled_count"],
        uploaded_count=counters["uploaded_count"],
        preprocessing_count=counters["preprocessing_count"],
        ready_count=counters["ready_count"],
        queued_count=counters["queued_count"],
        running_count=counters["running_count"],
        needs_review_count=counters["needs_review_count"],
        progress_phase=counters["progress_phase"],
        progress=counters["progress"],
        items=items if include_items else [],
        created_at=batch.created_at,
        completed_at=batch.completed_at,
    )


def _required_field_batch_item_read(item: RequiredFieldCheckBatchItem) -> RequiredFieldCheckBatchItemRead:
    return RequiredFieldCheckBatchItemRead(
        id=item.id,
        document_id=item.document_id,
        job_id=item.job_id,
        filename=item.filename,
        upload_index=item.upload_index,
        status=item.job.status if item.job else "unknown",
        result_id=item.job.result_id if item.job else None,
        error_message=item.job.error_message if item.job else None,
        created_at=item.created_at,
    )


def _owner_counters(total_count: int, statuses: list[str], owner_status: str) -> dict[str, Any]:
    completed_statuses = {"completed", "needs_review"}
    terminal_statuses = {"completed", "needs_review", "failed", "canceled"}
    uploaded_count = len(statuses)
    preprocessing_count = sum(1 for status in statuses if status in {"uploading", "preprocessing"})
    queued_count = sum(1 for status in statuses if status == "queued")
    running_count = sum(1 for status in statuses if status == "running")
    needs_review_count = sum(1 for status in statuses if status == "needs_review")
    completed_count = sum(1 for status in statuses if status in completed_statuses)
    failed_count = sum(1 for status in statuses if status == "failed")
    canceled_count = sum(1 for status in statuses if status == "canceled")
    finished_count = sum(1 for status in statuses if status in terminal_statuses)
    ready_count = max(0, uploaded_count - preprocessing_count)
    if owner_status in {"canceled", "failed"} and not statuses:
        status = owner_status
        progress_phase = owner_status
    elif total_count and finished_count >= total_count:
        if canceled_count == total_count:
            status = "canceled"
        elif failed_count or canceled_count:
            status = "completed_with_errors"
        else:
            status = "completed"
        progress_phase = status
    elif uploaded_count < total_count:
        status = "uploading"
        progress_phase = "uploading"
    elif preprocessing_count:
        status = "preprocessing"
        progress_phase = "preprocessing"
    elif running_count or owner_status == "running":
        status = "running"
        progress_phase = "running"
    elif canceled_count:
        status = "canceling"
        progress_phase = "running"
    elif queued_count:
        status = "queued"
        progress_phase = "queued"
    else:
        status = owner_status
        progress_phase = owner_status
    progress = finished_count / total_count if total_count else 0
    return {
        "status": status,
        "uploaded_count": uploaded_count,
        "preprocessing_count": preprocessing_count,
        "ready_count": ready_count,
        "queued_count": queued_count,
        "running_count": running_count,
        "completed_count": completed_count,
        "failed_count": failed_count,
        "canceled_count": canceled_count,
        "needs_review_count": needs_review_count,
        "progress_phase": progress_phase,
        "progress": progress,
    }


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


def _prepare_workflow_run_resume(run: WorkflowRun) -> int:
    queued_count = 0
    now = datetime.utcnow()
    for item in run.items:
        if item.status == "queued":
            queued_count += 1
            continue
        if item.status not in {"paused", "running", "preprocessing"}:
            continue
        if item.document and item.document.status == "ready" and item.document.pages:
            item.status = "queued"
            item.error_message = None
            item.completed_at = None
            queued_count += 1
        else:
            item.status = "failed"
            item.error_message = item.document.error_message if item.document else "Document preprocessing was interrupted"
            item.completed_at = now
    return queued_count


def _prepare_workflow_run_restart(run: WorkflowRun) -> int:
    queued_count = 0
    now = datetime.utcnow()
    for item in run.items:
        if item.document and item.document.status == "ready" and item.document.pages:
            item.status = "queued"
            item.error_message = None
            item.completed_at = None
            item.inference_duration_ms = None
            item.execution_generation = run.execution_generation
            item.result_json = _initial_workflow_item_payload(item.document)
            queued_count += 1
        else:
            item.status = "failed"
            item.error_message = item.document.error_message if item.document else "Document preprocessing was interrupted"
            item.completed_at = now
            item.execution_generation = run.execution_generation
    return queued_count


def _create_restarted_workflow_run(
    source_run: WorkflowRun,
    workflow: WorkflowDefinition,
    now: datetime,
    db: Session,
) -> tuple[WorkflowRun, int]:
    new_run = WorkflowRun(
        workflow_id=workflow.id,
        workflow_name=workflow.name,
        workflow_definition_json=workflow.definition_json,
        restarted_from_run_id=source_run.id,
        status="running",
        total_count=source_run.total_count,
        upload_duration_ms=source_run.upload_duration_ms or _workflow_upload_duration_ms(source_run),
        inference_started_at=now,
        execution_generation=1,
    )
    db.add(new_run)
    db.flush()

    queued_count = 0
    for source_item in _sorted_workflow_items(source_run.items):
        document = source_item.document or db.get(Document, source_item.document_id)
        ready = bool(document and document.status == "ready" and document.pages)
        status = "queued" if ready else "failed"
        message = None if ready else (document.error_message if document else source_item.error_message or "Document preprocessing was interrupted")
        result_json = (
            _initial_workflow_item_payload(document)
            if ready and document
            else json.dumps(
                {
                    "document_id": source_item.document_id,
                    "filename": source_item.filename,
                    "node_results": {},
                    "error_message": message,
                },
                ensure_ascii=False,
            )
        )
        db.add(
            WorkflowRunItem(
                run_id=new_run.id,
                document_id=source_item.document_id,
                filename=source_item.filename,
                upload_index=source_item.upload_index,
                status=status,
                error_message=message,
                client_file_id=source_item.client_file_id,
                upload_duration_ms=source_item.upload_duration_ms,
                execution_generation=new_run.execution_generation,
                result_json=result_json,
                completed_at=None if ready else now,
            )
        )
        if ready:
            queued_count += 1
    return new_run, queued_count


def _create_waiting_workflow_run(
    source_run: WorkflowRun,
    workflow: WorkflowDefinition,
    now: datetime,
    db: Session,
) -> tuple[WorkflowRun, int]:
    group_id = _ensure_workflow_queue_group(source_run, db)
    queue_order = _next_workflow_queue_order(db, group_id)
    new_run = WorkflowRun(
        workflow_id=workflow.id,
        workflow_name=workflow.name,
        workflow_definition_json=workflow.definition_json,
        workflow_run_group_id=group_id,
        queued_from_run_id=source_run.id,
        queue_order=queue_order,
        status="waiting",
        total_count=source_run.total_count,
        upload_duration_ms=source_run.upload_duration_ms or _workflow_upload_duration_ms(source_run),
        execution_generation=0,
    )
    db.add(new_run)
    db.flush()

    queued_count = 0
    for source_item in _sorted_workflow_items(source_run.items):
        document = source_item.document or db.get(Document, source_item.document_id)
        ready = bool(document and document.status == "ready" and document.pages)
        status = "queued" if ready else "failed"
        message = None if ready else (document.error_message if document else source_item.error_message or "Document preprocessing was interrupted")
        result_json = (
            _initial_workflow_item_payload(document)
            if ready and document
            else json.dumps(
                {
                    "document_id": source_item.document_id,
                    "filename": source_item.filename,
                    "node_results": {},
                    "error_message": message,
                },
                ensure_ascii=False,
            )
        )
        db.add(
            WorkflowRunItem(
                run_id=new_run.id,
                document_id=source_item.document_id,
                filename=source_item.filename,
                upload_index=source_item.upload_index,
                status=status,
                error_message=message,
                client_file_id=source_item.client_file_id,
                upload_duration_ms=source_item.upload_duration_ms,
                execution_generation=new_run.execution_generation,
                result_json=result_json,
                completed_at=None if ready else now,
            )
        )
        if ready:
            queued_count += 1
    return new_run, queued_count


def _ensure_workflow_queue_group(run: WorkflowRun, db: Session) -> str:
    group_id = run.workflow_run_group_id or run.id
    run.workflow_run_group_id = group_id
    if run.queue_order is None:
        run.queue_order = 1 if run.id == group_id else _next_workflow_queue_order(db, group_id)
    db.flush()
    return group_id


def _next_workflow_queue_order(db: Session, group_id: str) -> int:
    orders = [
        order
        for (order,) in db.query(WorkflowRun.queue_order).filter(WorkflowRun.workflow_run_group_id == group_id).all()
        if order is not None
    ]
    return max(orders, default=0) + 1


def _validate_workflow_enqueue_source(run: WorkflowRun) -> None:
    if run.status not in WORKFLOW_ENQUEUE_BLOCKED_STATUSES:
        return
    if run.status == "waiting":
        detail = "Waiting workflow runs cannot be enqueued again"
    elif run.status == "canceled":
        detail = "Canceled workflow runs cannot be enqueued"
    else:
        detail = "Failed workflow runs cannot be enqueued"
    raise HTTPException(status_code=409, detail=detail)


def _validate_waiting_workflow_run_can_start(run: WorkflowRun, db: Session) -> None:
    group_id = run.workflow_run_group_id or run.id
    first_waiting = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.workflow_run_group_id == group_id, WorkflowRun.status == "waiting")
        .order_by(WorkflowRun.queue_order.asc(), WorkflowRun.created_at.asc(), WorkflowRun.id.asc())
        .first()
    )
    if not first_waiting or first_waiting.id != run.id:
        raise HTTPException(status_code=409, detail="Only the first waiting workflow run can be started")

    run_position = _workflow_queue_position(run)
    active_predecessors = [
        candidate
        for candidate in db.query(WorkflowRun).filter(WorkflowRun.workflow_run_group_id == group_id).all()
        if candidate.id != run.id
        and candidate.status not in WORKFLOW_RUN_TERMINAL_STATUSES
        and _workflow_queue_position(candidate) < run_position
    ]
    if active_predecessors:
        raise HTTPException(status_code=409, detail="Previous workflow runs in this queue are still active")


def _workflow_queue_position(run: WorkflowRun) -> tuple[int, datetime, str]:
    return (run.queue_order if run.queue_order is not None else 0, run.created_at or datetime.min, run.id)


def _cancel_waiting_workflow_run(run: WorkflowRun, db: Session) -> None:
    now = datetime.utcnow()
    canceled_count = 0
    for item in run.items:
        if item.status in {"queued", "preprocessing", "running", "paused"}:
            item.status = "canceled"
            item.error_message = "Removed from workflow run queue"
            item.completed_at = now
            canceled_count += 1
    run.status = "canceled"
    run.error_message = "Removed from workflow run queue"
    run.completed_at = now
    run.inference_started_at = None
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="queue_canceled",
        message=f"Canceled waiting workflow run with {canceled_count} queued item(s)",
        metadata={"workflow_id": run.workflow_id, "queue_group_id": run.workflow_run_group_id, "queue_order": run.queue_order},
    )


def _unshared_workflow_document_ids(run: WorkflowRun, document_ids: list[str], db: Session) -> list[str]:
    unique_document_ids = sorted({document_id for document_id in document_ids if document_id})
    if not unique_document_ids:
        return []
    shared_document_ids = {
        document_id
        for (document_id,) in db.query(WorkflowRunItem.document_id)
        .filter(WorkflowRunItem.run_id != run.id, WorkflowRunItem.document_id.in_(unique_document_ids))
        .all()
    }
    return [document_id for document_id in unique_document_ids if document_id not in shared_document_ids]


def _prepare_workflow_run_retry_failed(run: WorkflowRun) -> int:
    queued_count = 0
    now = datetime.utcnow()
    for item in run.items:
        if item.status != "failed":
            continue
        if item.document and item.document.status == "ready" and item.document.pages:
            item.status = "queued"
            item.error_message = None
            item.completed_at = None
            item.inference_duration_ms = None
            item.execution_generation = run.execution_generation
            item.result_json = _initial_workflow_item_payload(item.document)
            queued_count += 1
        else:
            item.error_message = item.document.error_message if item.document else "Document preprocessing was interrupted"
            item.completed_at = now
            item.execution_generation = run.execution_generation
    return queued_count


def _workflow_upload_duration_ms(run: WorkflowRun) -> int | None:
    durations = [item.upload_duration_ms for item in run.items if item.upload_duration_ms is not None]
    if not durations:
        return None
    return sum(durations)


def _duration_ms(started_at: datetime, ended_at: datetime | None = None) -> int:
    ended = ended_at or datetime.utcnow()
    return max(0, int((ended - started_at).total_seconds() * 1000))


def _accumulate_workflow_run_inference_duration(run: WorkflowRun, ended_at: datetime) -> None:
    if not run.inference_started_at:
        return
    run.inference_duration_ms = (run.inference_duration_ms or 0) + _duration_ms(run.inference_started_at, ended_at)
    run.inference_started_at = None


def _prepare_job_batch_resume(items: list[Any]) -> None:
    now = datetime.utcnow()
    for item in items:
        job = item.job
        document = item.document
        if not job:
            continue
        if job.status == "queued":
            continue
        if job.status not in {"running", "preprocessing"}:
            continue
        if document and document.status == "ready" and document.pages:
            job.status = "queued"
            job.error_message = None
            job.started_at = None
            job.completed_at = None
        else:
            job.status = "failed"
            job.error_message = document.error_message if document else "Document preprocessing was interrupted"
            job.completed_at = now


def _discard_batch_items(batch: Any, db: Session) -> int:
    items = list(batch.items)
    document_ids = [item.document_id for item in items]
    for item in items:
        db.delete(item)
    _delete_document_payloads(document_ids, db)
    return len(items)


def _delete_document_payloads(document_ids: list[str], db: Session) -> None:
    unique_document_ids = sorted({document_id for document_id in document_ids if document_id})
    if not unique_document_ids:
        return
    _delete_jobs_for_documents(unique_document_ids, db)
    documents = db.query(Document).filter(Document.id.in_(unique_document_ids)).all()
    for document in documents:
        _delete_document_storage(document)
        for page in list(document.pages):
            db.delete(page)
        db.delete(document)


def _delete_jobs_for_documents(document_ids: list[str], db: Session) -> None:
    for model in (ExtractionJob, ClassificationJob, RequiredFieldCheckJob):
        jobs = db.query(model).filter(model.document_id.in_(document_ids)).all()
        for job in jobs:
            if job.result:
                db.delete(job.result)
            db.delete(job)


def _delete_document_storage(document: Document) -> None:
    refs = [document.storage_path, *(page.image_path for page in document.pages)]
    local_deleted = False
    if document.storage_path and not is_s3_ref(document.storage_path):
        storage_root = get_settings().resolved_storage_dir.resolve()
        document_dir = Path(document.storage_path).resolve().parent
        if document_dir != storage_root and storage_root in document_dir.parents:
            delete_storage_ref(document_dir)
            local_deleted = True
    if local_deleted:
        return
    for ref in refs:
        if ref:
            delete_storage_ref(ref)


def _sorted_batch_items(items) -> list[BatchItem]:
    return sorted(items, key=_batch_item_sort_key)


def _batch_item_sort_key(item: BatchItem) -> tuple[str, str]:
    upload_index = getattr(item, "upload_index", None)
    if upload_index is not None:
        return (f"{upload_index:012d}", item.id)
    return (f"z:{item.filename.casefold()}", item.id)


def _sorted_module_items(items) -> list[Any]:
    return sorted(items, key=_module_item_sort_key)


def _sorted_workflow_items(items) -> list[WorkflowRunItem]:
    return sorted(items, key=_module_item_sort_key)


def _module_item_sort_key(item: Any) -> tuple[str, str]:
    upload_index = getattr(item, "upload_index", None)
    if upload_index is not None:
        return (f"{upload_index:012d}", item.id)
    return (f"z:{item.filename.casefold()}", item.id)


def _upload_file_sort_key(file: UploadFile) -> tuple[str, str]:
    filename = file.filename or ""
    return (filename.casefold(), filename)


async def _read_batch_upload_form(request: Request) -> tuple[FormData, list[UploadFile]]:
    settings = get_settings()
    try:
        form = await request.form(
            max_files=_multipart_max_files(settings.upload_max_batch_files),
            max_fields=max(32, settings.upload_chunk_files * 3 + 16),
        )
    except StarletteHTTPException as exc:
        detail = str(exc.detail)
        if "Too many files" in detail or "Maximum number of files" in detail:
            raise HTTPException(status_code=413, detail=_batch_file_limit_message()) from exc
        raise HTTPException(status_code=400, detail=f"Invalid multipart upload: {detail}") from exc
    except OSError as exc:
        if exc.errno == errno.EMFILE:
            raise HTTPException(
                status_code=413,
                detail="Too many files were uploaded in a single request. Upload large batches in smaller chunks.",
            ) from exc
        raise

    files = [item for item in form.getlist("files") if _is_upload_file(item)]
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    _validate_upload_file_count(files)
    return form, files


def _multipart_max_files(upload_limit: int) -> int:
    if upload_limit > 0:
        return max(1000, upload_limit)
    return 10000


def _is_upload_file(value: Any) -> bool:
    return hasattr(value, "filename") and hasattr(value, "file")


def _required_form_value(form: FormData, key: str) -> str:
    value = form.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"{key} is required")
    return value.strip()


def _validate_upload_file_count(files: list[UploadFile]) -> None:
    limit = get_settings().upload_max_batch_files
    if limit > 0 and len(files) > limit:
        raise HTTPException(status_code=413, detail=_batch_file_limit_message())


def _validate_declared_batch_file_count(file_count: int) -> None:
    limit = get_settings().upload_max_batch_files
    if limit > 0 and file_count > limit:
        raise HTTPException(status_code=413, detail=_batch_file_limit_message())


def _batch_file_limit_message() -> str:
    limit = get_settings().upload_max_batch_files
    if limit > 0:
        return f"Batch file count exceeds the configured limit of {limit}"
    return "Batch file count exceeds the multipart parser limit"


def _ordered_upload_entries(form: FormData, files: list[UploadFile]) -> list[tuple[UploadFile, str | None, int | None]]:
    raw_client_ids = [value if isinstance(value, str) and value.strip() else None for value in form.getlist("client_file_ids")]
    if len(raw_client_ids) != len(files):
        raw_client_ids = [None] * len(files)
    raw_upload_indexes: list[int | None] = []
    for value in form.getlist("upload_indexes"):
        if isinstance(value, str) and value.strip():
            try:
                parsed = int(value)
                raw_upload_indexes.append(parsed if parsed >= 0 else None)
            except ValueError:
                raw_upload_indexes.append(None)
        else:
            raw_upload_indexes.append(None)
    if len(raw_upload_indexes) != len(files):
        raw_upload_indexes = [None] * len(files)
    return sorted(
        zip(files, raw_client_ids, raw_upload_indexes, strict=False),
        key=lambda entry: (entry[2] is None, entry[2] if entry[2] is not None else 0, *_upload_file_sort_key(entry[0])),
    )


def _existing_client_file_ids(db: Session, item_model: Any, owner_field: str, owner_id: str, client_file_ids: list[str | None]) -> set[str]:
    ids = [client_file_id for client_file_id in client_file_ids if client_file_id]
    if not ids:
        return set()
    rows = (
        db.query(item_model.client_file_id)
        .filter(getattr(item_model, owner_field) == owner_id, item_model.client_file_id.in_(ids))
        .all()
    )
    return {row[0] for row in rows if row[0]}


def _existing_upload_indexes(db: Session, item_model: Any, owner_field: str, owner_id: str, upload_indexes: list[int | None]) -> set[int]:
    if not hasattr(item_model, "upload_index"):
        return set()
    indexes = [upload_index for upload_index in upload_indexes if upload_index is not None]
    if not indexes:
        return set()
    rows = (
        db.query(item_model.upload_index)
        .filter(getattr(item_model, owner_field) == owner_id, item_model.upload_index.in_(indexes))
        .all()
    )
    return {row[0] for row in rows if row[0] is not None}


def _filter_new_upload_entries(
    db: Session,
    item_model: Any,
    owner_field: str,
    owner_id: str,
    entries: list[tuple[UploadFile, str | None, int | None]],
) -> list[tuple[UploadFile, str | None, int | None]]:
    existing_ids = _existing_client_file_ids(db, item_model, owner_field, owner_id, [client_id for _, client_id, _ in entries])
    existing_indexes = _existing_upload_indexes(db, item_model, owner_field, owner_id, [upload_index for _, _, upload_index in entries])
    accepted_ids = set(existing_ids)
    accepted_indexes = set(existing_indexes)
    new_entries: list[tuple[UploadFile, str | None, int | None]] = []
    for file, client_file_id, upload_index in entries:
        if client_file_id and client_file_id in accepted_ids:
            continue
        if upload_index is not None and upload_index in accepted_indexes:
            continue
        new_entries.append((file, client_file_id, upload_index))
        if client_file_id:
            accepted_ids.add(client_file_id)
        if upload_index is not None:
            accepted_indexes.add(upload_index)
    return new_entries


def _ensure_upload_append_capacity(
    db: Session,
    item_model: Any,
    owner_field: str,
    owner_id: str,
    total_count: int,
    incoming_count: int,
) -> None:
    current_count = db.query(item_model).filter(getattr(item_model, owner_field) == owner_id).count()
    if current_count + incoming_count > total_count:
        raise HTTPException(status_code=413, detail="Batch upload exceeds declared file count")


def _upload_failure_message(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return str(exc.detail)
    if isinstance(exc, DocumentProcessingError):
        return str(exc)
    return "Failed to process uploaded document"


def _initial_workflow_item_payload(document: Document) -> str:
    return json.dumps({"document_id": document.id, "filename": document.filename, "node_results": {}}, ensure_ascii=False)


async def _append_workflow_upload_items(run: WorkflowRun, form: FormData, files: list[UploadFile], db: Session) -> None:
    entries = _filter_new_upload_entries(db, WorkflowRunItem, "run_id", run.id, _ordered_upload_entries(form, files))
    incoming_count = len(entries)
    _ensure_upload_append_capacity(db, WorkflowRunItem, "run_id", run.id, run.total_count, incoming_count)

    for file, client_file_id, upload_index in entries:
        upload_started_at = datetime.utcnow()
        try:
            db.refresh(run)
            if not _owner_accepts_uploads(run):
                continue
            document, original_path = _create_uploaded_document(file, db)
            item = WorkflowRunItem(
                run_id=run.id,
                document_id=document.id,
                filename=document.filename,
                upload_index=upload_index,
                status="preprocessing",
                client_file_id=client_file_id,
                result_json=_initial_workflow_item_payload(document),
            )
            db.add(item)
            log_audit_event(
                db,
                entity_type="workflow_run_item",
                entity_id=run.id,
                action="preprocessing",
                message=f"Preprocessing workflow document {document.filename}",
                metadata={"document_id": document.id},
            )
            db.commit()

            ok = _preprocess_document_pages(document, original_path, db, raise_errors=False)
            db.refresh(run)
            if not _owner_accepts_uploads(run):
                db.rollback()
                continue
            if ok:
                item.status = "queued"
                item.error_message = None
                item.upload_duration_ms = _duration_ms(upload_started_at)
                log_audit_event(
                    db,
                    entity_type="workflow_run_item",
                    entity_id=run.id,
                    action="queued",
                    message=f"Queued workflow document {document.filename}",
                    metadata={"document_id": document.id},
                )
            else:
                item.status = "failed"
                item.error_message = document.error_message
                item.completed_at = datetime.utcnow()
                item.upload_duration_ms = _duration_ms(upload_started_at, item.completed_at)
                item.result_json = json.dumps(
                    {
                        "document_id": document.id,
                        "filename": document.filename,
                        "node_results": {},
                        "error_message": document.error_message,
                    },
                    ensure_ascii=False,
                )
            db.commit()
        except Exception as exc:
            db.rollback()
            _record_failed_workflow_upload_item(run, file, client_file_id, upload_index, _duration_ms(upload_started_at), _upload_failure_message(exc), db)
        finally:
            await file.close()


def _record_failed_workflow_upload_item(
    run: WorkflowRun,
    file: UploadFile,
    client_file_id: str | None,
    upload_index: int | None,
    upload_duration_ms: int | None,
    message: str,
    db: Session,
) -> None:
    document = _create_failed_upload_document(file, message, db)
    item = WorkflowRunItem(
        run_id=run.id,
        document_id=document.id,
        filename=document.filename,
        upload_index=upload_index,
        status="failed",
        error_message=message,
        client_file_id=client_file_id,
        upload_duration_ms=upload_duration_ms,
        result_json=json.dumps(
            {"document_id": document.id, "filename": document.filename, "node_results": {}, "error_message": message},
            ensure_ascii=False,
        ),
        completed_at=datetime.utcnow(),
    )
    db.add(item)
    log_audit_event(
        db,
        entity_type="workflow_run_item",
        entity_id=run.id,
        action="failed",
        message=message,
        metadata={"document_id": document.id},
    )
    db.commit()


def _seal_missing_workflow_upload_items(run: WorkflowRun, db: Session) -> int:
    existing_count = db.query(WorkflowRunItem).filter(WorkflowRunItem.run_id == run.id).count()
    missing_count = max(0, run.total_count - existing_count)
    if missing_count == 0:
        return 0
    existing_indexes = {
        row[0]
        for row in db.query(WorkflowRunItem.upload_index)
        .filter(WorkflowRunItem.run_id == run.id, WorkflowRunItem.upload_index.isnot(None))
        .all()
    }
    candidate_indexes = [index for index in range(run.total_count) if index not in existing_indexes]
    if len(candidate_indexes) < missing_count:
        candidate_indexes.extend([None] * (missing_count - len(candidate_indexes)))
    now = datetime.utcnow()
    message = "Upload was not received before execution was restarted"
    for ordinal, upload_index in enumerate(candidate_indexes[:missing_count], start=1):
        suffix = upload_index + 1 if upload_index is not None else existing_count + ordinal
        filename = f"missing_upload_{suffix:05d}"
        document = _create_failed_upload_document_record(filename, "application/octet-stream", message, db)
        db.add(
            WorkflowRunItem(
                run_id=run.id,
                document_id=document.id,
                filename=document.filename,
                upload_index=upload_index,
                status="failed",
                error_message=message,
                client_file_id=f"missing:{run.id}:{upload_index}" if upload_index is not None else None,
                result_json=json.dumps(
                    {"document_id": document.id, "filename": document.filename, "node_results": {}, "error_message": message},
                    ensure_ascii=False,
                ),
                completed_at=now,
            )
        )
    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=run.id,
        action="upload_sealed",
        message=f"Marked {missing_count} missing upload slot(s) as failed",
        metadata={"workflow_id": run.workflow_id, "missing_count": missing_count},
    )
    db.flush()
    return missing_count


async def _append_extraction_batch_items(batch: Batch, form: FormData, files: list[UploadFile], db: Session) -> None:
    entries = _filter_new_upload_entries(db, BatchItem, "batch_id", batch.id, _ordered_upload_entries(form, files))
    incoming_count = len(entries)
    _ensure_upload_append_capacity(db, BatchItem, "batch_id", batch.id, batch.total_count, incoming_count)

    for file, client_file_id, upload_index in entries:
        try:
            db.refresh(batch)
            if not _owner_accepts_uploads(batch):
                continue
            document, original_path = _create_uploaded_document(file, db)
            job = ExtractionJob(document_id=document.id, schema_id=batch.schema_id, schema_version=batch.schema_version, status="preprocessing")
            db.add(job)
            db.flush()
            db.add(
                BatchItem(
                    batch_id=batch.id,
                    document_id=document.id,
                    job_id=job.id,
                    filename=document.filename,
                    upload_index=upload_index,
                    client_file_id=client_file_id,
                )
            )
            log_audit_event(
                db,
                entity_type="document",
                entity_id=document.id,
                action="uploaded",
                message=f"Batch uploaded {document.filename}",
                metadata={"batch_id": batch.id, "filename": document.filename},
            )
            db.commit()

            ok = _preprocess_document_pages(document, original_path, db, raise_errors=False)
            db.refresh(batch)
            if not _owner_accepts_uploads(batch):
                db.rollback()
                continue
            if ok:
                job.status = "queued"
                job.error_message = None
                log_audit_event(
                    db,
                    entity_type="extraction_job",
                    entity_id=job.id,
                    action="created",
                    message="Batch extraction job created",
                    metadata={"batch_id": batch.id, "document_id": document.id, "schema_id": batch.schema_id},
                )
            else:
                job.status = "failed"
                job.error_message = document.error_message
                job.completed_at = datetime.utcnow()
            db.commit()
        except Exception as exc:
            db.rollback()
            _record_failed_extraction_batch_item(batch, file, client_file_id, upload_index, _upload_failure_message(exc), db)
        finally:
            await file.close()


def _record_failed_extraction_batch_item(
    batch: Batch,
    file: UploadFile,
    client_file_id: str | None,
    upload_index: int | None,
    message: str,
    db: Session,
) -> None:
    document = _create_failed_upload_document(file, message, db)
    job = ExtractionJob(
        document_id=document.id,
        schema_id=batch.schema_id,
        schema_version=batch.schema_version,
        status="failed",
        error_message=message,
        completed_at=datetime.utcnow(),
    )
    db.add(job)
    db.flush()
    db.add(
        BatchItem(
            batch_id=batch.id,
            document_id=document.id,
            job_id=job.id,
            filename=document.filename,
            upload_index=upload_index,
            client_file_id=client_file_id,
        )
    )
    log_audit_event(db, entity_type="extraction_job", entity_id=job.id, action="failed", message=message, metadata={"batch_id": batch.id})
    db.commit()


async def _append_classification_batch_items(batch: ClassificationBatch, form: FormData, files: list[UploadFile], db: Session) -> None:
    entries = _filter_new_upload_entries(db, ClassificationBatchItem, "batch_id", batch.id, _ordered_upload_entries(form, files))
    incoming_count = len(entries)
    _ensure_upload_append_capacity(db, ClassificationBatchItem, "batch_id", batch.id, batch.total_count, incoming_count)

    for file, client_file_id, upload_index in entries:
        try:
            db.refresh(batch)
            if not _owner_accepts_uploads(batch):
                continue
            document, original_path = _create_uploaded_document(file, db)
            job = ClassificationJob(document_id=document.id, classifier_id=batch.classifier_id, status="preprocessing")
            db.add(job)
            db.flush()
            db.add(
                ClassificationBatchItem(
                    batch_id=batch.id,
                    document_id=document.id,
                    job_id=job.id,
                    filename=document.filename,
                    upload_index=upload_index,
                    client_file_id=client_file_id,
                )
            )
            db.commit()

            ok = _preprocess_document_pages(document, original_path, db, raise_errors=False)
            db.refresh(batch)
            if not _owner_accepts_uploads(batch):
                db.rollback()
                continue
            if ok:
                job.status = "queued"
                job.error_message = None
                log_audit_event(
                    db,
                    entity_type="classification_job",
                    entity_id=job.id,
                    action="queued",
                    message="Queued classification batch job",
                    metadata={"batch_id": batch.id, "document_id": document.id, "classifier_id": batch.classifier_id},
                )
            else:
                job.status = "failed"
                job.error_message = document.error_message
                job.completed_at = datetime.utcnow()
            db.commit()
        except Exception as exc:
            db.rollback()
            _record_failed_classification_batch_item(batch, file, client_file_id, upload_index, _upload_failure_message(exc), db)
        finally:
            await file.close()


def _record_failed_classification_batch_item(
    batch: ClassificationBatch,
    file: UploadFile,
    client_file_id: str | None,
    upload_index: int | None,
    message: str,
    db: Session,
) -> None:
    document = _create_failed_upload_document(file, message, db)
    job = ClassificationJob(
        document_id=document.id,
        classifier_id=batch.classifier_id,
        status="failed",
        error_message=message,
        completed_at=datetime.utcnow(),
    )
    db.add(job)
    db.flush()
    db.add(
        ClassificationBatchItem(
            batch_id=batch.id,
            document_id=document.id,
            job_id=job.id,
            filename=document.filename,
            upload_index=upload_index,
            client_file_id=client_file_id,
        )
    )
    log_audit_event(db, entity_type="classification_job", entity_id=job.id, action="failed", message=message, metadata={"batch_id": batch.id})
    db.commit()


async def _append_required_field_batch_items(batch: RequiredFieldCheckBatch, form: FormData, files: list[UploadFile], db: Session) -> None:
    entries = _filter_new_upload_entries(db, RequiredFieldCheckBatchItem, "batch_id", batch.id, _ordered_upload_entries(form, files))
    incoming_count = len(entries)
    _ensure_upload_append_capacity(db, RequiredFieldCheckBatchItem, "batch_id", batch.id, batch.total_count, incoming_count)

    for file, client_file_id, upload_index in entries:
        try:
            db.refresh(batch)
            if not _owner_accepts_uploads(batch):
                continue
            document, original_path = _create_uploaded_document(file, db)
            job = RequiredFieldCheckJob(document_id=document.id, checklist_id=batch.checklist_id, status="preprocessing")
            db.add(job)
            db.flush()
            db.add(
                RequiredFieldCheckBatchItem(
                    batch_id=batch.id,
                    document_id=document.id,
                    job_id=job.id,
                    filename=document.filename,
                    upload_index=upload_index,
                    client_file_id=client_file_id,
                )
            )
            db.commit()

            ok = _preprocess_document_pages(document, original_path, db, raise_errors=False)
            db.refresh(batch)
            if not _owner_accepts_uploads(batch):
                db.rollback()
                continue
            if ok:
                job.status = "queued"
                job.error_message = None
                log_audit_event(
                    db,
                    entity_type="required_field_check_job",
                    entity_id=job.id,
                    action="queued",
                    message="Queued required field check batch job",
                    metadata={"batch_id": batch.id, "document_id": document.id, "checklist_id": batch.checklist_id},
                )
            else:
                job.status = "failed"
                job.error_message = document.error_message
                job.completed_at = datetime.utcnow()
            db.commit()
        except Exception as exc:
            db.rollback()
            _record_failed_required_field_batch_item(batch, file, client_file_id, upload_index, _upload_failure_message(exc), db)
        finally:
            await file.close()


def _record_failed_required_field_batch_item(
    batch: RequiredFieldCheckBatch,
    file: UploadFile,
    client_file_id: str | None,
    upload_index: int | None,
    message: str,
    db: Session,
) -> None:
    document = _create_failed_upload_document(file, message, db)
    job = RequiredFieldCheckJob(
        document_id=document.id,
        checklist_id=batch.checklist_id,
        status="failed",
        error_message=message,
        completed_at=datetime.utcnow(),
    )
    db.add(job)
    db.flush()
    db.add(
        RequiredFieldCheckBatchItem(
            batch_id=batch.id,
            document_id=document.id,
            job_id=job.id,
            filename=document.filename,
            upload_index=upload_index,
            client_file_id=client_file_id,
        )
    )
    log_audit_event(db, entity_type="required_field_check_job", entity_id=job.id, action="failed", message=message, metadata={"batch_id": batch.id})
    db.commit()


def _queued_extraction_job_ids(batch: Batch) -> list[str]:
    return [item.job_id for item in batch.items if item.job and item.job.status == "queued"]


def _owner_accepts_uploads(owner: Any) -> bool:
    return getattr(owner, "status", None) in {"uploading", "queued"}


def _queued_classification_job_ids(batch: ClassificationBatch) -> list[str]:
    return [item.job_id for item in batch.items if item.job and item.job.status == "queued"]


def _queued_required_field_job_ids(batch: RequiredFieldCheckBatch) -> list[str]:
    return [item.job_id for item in batch.items if item.job and item.job.status == "queued"]


def _validate_owner_can_start(owner: Any, items: list[Any]) -> None:
    _validate_owner_upload_complete(owner, items)
    preprocessing_count = sum(1 for item in items if _upload_item_status(item) == "preprocessing")
    if preprocessing_count:
        raise HTTPException(
            status_code=422,
            detail={"message": f"{preprocessing_count} file(s) are still preprocessing", "preprocessing_count": preprocessing_count},
        )


def _validate_owner_upload_complete(owner: Any, items: list[Any]) -> None:
    uploaded_count = len(items)
    if uploaded_count != owner.total_count:
        missing_count = max(0, owner.total_count - uploaded_count)
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Upload is incomplete. Re-select the original files to continue uploading before starting execution.",
                "uploaded_count": uploaded_count,
                "total_count": owner.total_count,
                "missing_count": missing_count,
            },
        )


def _upload_item_status(item: Any) -> str:
    status = getattr(item, "status", None)
    if isinstance(status, str):
        return status
    job = getattr(item, "job", None)
    if job and isinstance(job.status, str):
        return job.status
    return "unknown"


def _extract_kie_cell_value(value: Any) -> Any:
    return value.get("value") if isinstance(value, dict) else value


def _add_kie_review_export_columns(
    row: dict[str, Any],
    column_prefix: str,
    value: Any,
    original_value: Any = None,
    reviewed_fields: set[str] | None = None,
    field_name: str | None = None,
) -> None:
    value_dict = value if isinstance(value, dict) else {}
    ai_review = value_dict.get("ai_review") if isinstance(value_dict.get("ai_review"), dict) else {}
    current = _extract_kie_cell_value(value)
    original = _extract_kie_cell_value(original_value) if original_value is not None else current
    row[column_prefix] = current
    row[f"{column_prefix}_original"] = original
    row[f"{column_prefix}_changed"] = current != original
    row[f"{column_prefix}_reviewed"] = field_name in reviewed_fields if reviewed_fields is not None and field_name else False
    row[f"{column_prefix}_warnings"] = value_dict.get("warnings", [])
    row[f"{column_prefix}_ai_review_enabled"] = bool(ai_review.get("enabled"))
    row[f"{column_prefix}_ai_review_status"] = ai_review.get("judgement_status")
    row[f"{column_prefix}_ai_corrected"] = bool(ai_review.get("corrected"))
    row[f"{column_prefix}_ai_review_reason"] = ai_review.get("judgement_reason")
    row[f"{column_prefix}_ai_review_confidence"] = ai_review.get("judgement_confidence")
    row[f"{column_prefix}_ai_initial_value"] = ai_review.get("initial_value")
    row[f"{column_prefix}_ai_initial_evidence"] = ai_review.get("initial_evidence")
    row[f"{column_prefix}_ai_correction_reason"] = ai_review.get("correction_reason")


def _kie_export_columns(field_name: str) -> list[str]:
    return [
        field_name,
        f"{field_name}_original",
        f"{field_name}_changed",
        f"{field_name}_reviewed",
        f"{field_name}_warnings",
        f"{field_name}_ai_review_enabled",
        f"{field_name}_ai_review_status",
        f"{field_name}_ai_corrected",
        f"{field_name}_ai_review_reason",
        f"{field_name}_ai_review_confidence",
        f"{field_name}_ai_initial_value",
        f"{field_name}_ai_initial_evidence",
        f"{field_name}_ai_correction_reason",
    ]


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
    original_output = json.loads(job.result.validated_output)
    reviewed_fields = set(json.loads(job.result.reviewed_fields or "[]"))
    values = output.get("values", {})
    original_values = original_output.get("values", {}) if isinstance(original_output.get("values"), dict) else {}
    warnings: list[str] = []
    for field_name in field_names:
        value = values.get(field_name)
        if isinstance(value, dict):
            _add_kie_review_export_columns(row, field_name, value, original_values.get(field_name), reviewed_fields, field_name)
            warnings.extend(str(warning) for warning in value.get("warnings", []))
        else:
            _add_kie_review_export_columns(row, field_name, value, original_values.get(field_name), reviewed_fields, field_name)
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


def _safe_filename_part(value: Any, fallback: str = "export") -> str:
    text_value = str(value or "").strip() or fallback
    text_value = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", text_value)
    text_value = re.sub(r"\s+", "_", text_value)
    text_value = text_value.strip("._ ")
    return (text_value or fallback)[:100]


def _export_filename(module: str, name: Any, identifier: str, extension: str) -> str:
    return "_".join(
        [
            _safe_filename_part(module, "module"),
            _safe_filename_part(name, "untitled"),
            _safe_filename_part(identifier, "job"),
        ]
    ) + f".{extension}"


def _download_headers(filename: str) -> dict[str, str]:
    ascii_filename = "".join(ch if 32 <= ord(ch) < 127 else "_" for ch in filename).replace("\\", "_").replace('"', "_")
    ascii_filename = ascii_filename or "export"
    return {"Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{quote(filename)}"}


def _csv_download_response(content: str, filename: str) -> Response:
    return Response(
        content=f"\ufeff{content}",
        media_type="text/csv; charset=utf-8",
        headers=_download_headers(filename),
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
