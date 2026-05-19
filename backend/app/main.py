import csv
import io
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.audit import log_audit_event
from app.config import ROOT_ENV_PATH, get_settings, upsert_root_env
from app.database import get_db, init_db
from app.document_processor import DocumentProcessingError, rasterize_document, save_upload_file
from app.extraction import result_to_dict, run_extraction_job
from app.models import (
    AuditEvent,
    Batch,
    BatchItem,
    Document,
    DocumentPage,
    ExportPreset,
    ExtractionJob,
    ExtractionResult,
    RawExtraction,
    Schema,
    SchemaVersion,
)
from app.raw_extractor import RawExtractionError, RawExtractionOptions, create_raw_outputs, save_raw_upload, validate_raw_upload
from app.schemas import (
    ArchiveSearchResult,
    AuditEventRead,
    BatchItemRead,
    BatchRead,
    DocumentPageRead,
    DocumentRead,
    ExportPresetCreate,
    ExportPresetRead,
    ExportPresetUpdate,
    ExtractionJobCreate,
    ExtractionJobRead,
    ExtractionResultPatch,
    RawExtractionRead,
    SchemaCreate,
    SchemaRecommendationRead,
    SchemaRecommendationRequest,
    SchemaRead,
    SchemaUpdate,
    SystemStatusRead,
    VlmSettingsRead,
    VlmSettingsUpdate,
)
from app.vlm import recommend_schema_with_vlm


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(title="Digitize Your Document API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/system/status", response_model=SystemStatusRead)
def system_status() -> SystemStatusRead:
    settings = get_settings()
    provider = settings.vlm_provider.lower()
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
        provider=settings.vlm_provider.lower(),
        model_name=settings.resolved_vlm_model_name,
        has_api_key=bool(settings.resolved_vlm_api_key),
        env_path=str(ROOT_ENV_PATH),
    )


@app.put("/api/settings/vlm", response_model=VlmSettingsRead)
def update_vlm_settings(payload: VlmSettingsUpdate) -> VlmSettingsRead:
    provider = payload.provider.strip().lower() or "openai"
    if provider not in {"openai", "mock"}:
        raise HTTPException(status_code=400, detail="Only openai or mock provider is supported")

    updates = {
        "VLM_PROVIDER": provider,
        "VLM_MODEL_NAME": payload.model_name.strip(),
    }
    api_key = (payload.api_key or "").strip()
    if api_key:
        updates["VLM_API_KEY"] = api_key

    upsert_root_env(updates, include_defaults=True)
    return get_vlm_settings()


@app.post("/api/raw-extractions", response_model=RawExtractionRead)
def upload_raw_extraction(
    file: UploadFile = File(...),
    include_images: bool = Form(default=False),
    include_formulas: bool = Form(default=False),
    db: Session = Depends(get_db),
) -> RawExtractionRead:
    try:
        source_format = validate_raw_upload(file.filename or "")[1:]
    except RawExtractionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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
        raw.pdf_path = str(pdf_path)
        raw.html_path = str(html_path)
        raw.warnings = json.dumps(warnings, ensure_ascii=False)
        raw.status = "completed"
        raw.error_message = None
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
    path = Path(raw.pdf_path)
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
    path = Path(raw.html_path)
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
    path = Path(page.image_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document page image missing")
    return FileResponse(path, media_type="image/png")


@app.post("/api/schemas", response_model=SchemaRead)
def create_schema(payload: SchemaCreate, db: Session = Depends(get_db)) -> SchemaRead:
    schema = Schema(
        name=payload.name,
        display_name=payload.display_name,
        description=payload.description,
        current_version=1,
        is_template=payload.is_template,
        template_category=payload.template_category,
        pinned=payload.pinned,
    )
    db.add(schema)
    db.flush()
    schema_json = payload.model_dump()
    db.add(
        SchemaVersion(
            schema_id=schema.id,
            version=1,
            schema_json=json.dumps(schema_json, ensure_ascii=False),
        )
    )
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
    db: Session = Depends(get_db),
) -> list[SchemaRead]:
    query = db.query(Schema)
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
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        "fields": [field.model_dump() for field in payload.fields] if payload.fields is not None else current["fields"],
    }

    schema.name = next_schema_data["name"]
    schema.display_name = next_schema_data["display_name"]
    schema.description = next_schema_data["description"]
    schema.is_template = next_schema_data["is_template"]
    schema.template_category = next_schema_data["template_category"]
    schema.pinned = next_schema_data["pinned"]
    schema.current_version += 1
    db.add(
        SchemaVersion(
            schema_id=schema.id,
            version=schema.current_version,
            schema_json=json.dumps(next_schema_data, ensure_ascii=False),
        )
    )
    log_audit_event(
        db,
        entity_type="schema",
        entity_id=schema.id,
        action="updated",
        message=f"Updated schema {schema.name}",
        metadata={
            "version": schema.current_version,
            "is_template": schema.is_template,
            "field_count": len(next_schema_data["fields"]),
        },
    )
    db.commit()
    db.refresh(schema)
    return _schema_read(schema)


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

    schema_version = payload.schema_version or schema.current_version
    version_exists = (
        db.query(SchemaVersion)
        .filter(SchemaVersion.schema_id == schema.id, SchemaVersion.version == schema_version)
        .one_or_none()
    )
    if not version_exists:
        raise HTTPException(status_code=404, detail="Schema version not found")

    job = ExtractionJob(
        document_id=document.id,
        schema_id=schema.id,
        schema_version=schema_version,
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
        metadata={"document_id": document.id, "schema_id": schema.id, "schema_version": schema_version},
    )
    db.commit()
    db.refresh(job)
    background_tasks.add_task(run_extraction_job, job.id)
    return _job_read(job)


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
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{result_id}.csv"'},
    )


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


@app.post("/api/batches", response_model=BatchRead)
def create_batch(
    background_tasks: BackgroundTasks,
    schema_id: str = Form(...),
    schema_version: int | None = Form(default=None),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> BatchRead:
    schema = db.get(Schema, schema_id)
    if not schema:
        raise HTTPException(status_code=404, detail="Schema not found")
    version = schema_version or schema.current_version
    version_exists = (
        db.query(SchemaVersion)
        .filter(SchemaVersion.schema_id == schema.id, SchemaVersion.version == version)
        .one_or_none()
    )
    if not version_exists:
        raise HTTPException(status_code=404, detail="Schema version not found")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")

    batch = Batch(schema_id=schema.id, schema_version=version, status="running", total_count=len(files))
    db.add(batch)
    db.flush()
    for file in files:
        document = _create_document_from_upload(file, db)
        job = ExtractionJob(
            document_id=document.id,
            schema_id=schema.id,
            schema_version=version,
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
        background_tasks.add_task(run_extraction_job, job.id)

    log_audit_event(
        db,
        entity_type="batch",
        entity_id=batch.id,
        action="created",
        message=f"Created batch with {len(files)} file(s)",
        metadata={"schema_id": schema.id, "schema_version": version, "file_count": len(files)},
    )
    db.commit()
    db.refresh(batch)
    return _batch_read(batch)


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
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Failed to process uploaded document") from exc

    document = Document(
        filename=filename,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=size_bytes,
        page_count=len(pages),
        storage_path=str(original_path),
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


def _schema_read(schema: Schema) -> SchemaRead:
    schema_data = _schema_data(schema)
    return SchemaRead(
        id=schema.id,
        name=schema.name,
        display_name=schema.display_name,
        description=schema.description,
        current_version=schema.current_version,
        is_template=schema.is_template,
        template_category=schema.template_category,
        pinned=schema.pinned,
        fields=schema_data["fields"],
        created_at=schema.created_at,
        updated_at=schema.updated_at,
    )


def _schema_data(schema: Schema) -> dict[str, Any]:
    version = next((item for item in schema.versions if item.version == schema.current_version), None)
    if version is None:
        raise HTTPException(status_code=500, detail="Schema version is missing")
    return json.loads(version.schema_json)


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
        schema_version=job.schema_version,
        status=job.status,
        error_message=job.error_message,
        result_id=job.result_id,
        result=result_to_dict(job.result) if job.result else None,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


def _batch_read(batch: Batch) -> BatchRead:
    items = [_batch_item_read(item) for item in batch.items]
    completed_statuses = {"completed", "needs_review"}
    completed_count = sum(1 for item in items if item.status in completed_statuses)
    failed_count = sum(1 for item in items if item.status == "failed")
    finished_count = completed_count + failed_count
    if batch.total_count and finished_count >= batch.total_count:
        status = "completed" if failed_count == 0 else "completed_with_errors"
    else:
        status = "running"
    progress = finished_count / batch.total_count if batch.total_count else 0
    return BatchRead(
        id=batch.id,
        schema_id=batch.schema_id,
        schema_version=batch.schema_version,
        status=status,
        total_count=batch.total_count,
        completed_count=completed_count,
        failed_count=failed_count,
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
