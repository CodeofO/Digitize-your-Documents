import csv
import io
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.database import get_db, init_db
from app.document_processor import DocumentProcessingError, rasterize_document, save_upload_file
from app.extraction import result_to_dict, run_extraction_job
from app.models import Document, DocumentPage, ExtractionJob, ExtractionResult, Schema, SchemaVersion
from app.schemas import (
    DocumentPageRead,
    DocumentRead,
    ExtractionJobCreate,
    ExtractionJobRead,
    ExtractionResultPatch,
    SchemaCreate,
    SchemaRecommendationRead,
    SchemaRecommendationRequest,
    SchemaRead,
    SchemaUpdate,
)
from app.vlm import recommend_schema_with_vlm


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(title="KIE MVP API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/documents", response_model=DocumentRead)
def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db)) -> DocumentRead:
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
    db.commit()
    db.refresh(schema)
    return _schema_read(schema)


@app.get("/api/schemas", response_model=list[SchemaRead])
def list_schemas(db: Session = Depends(get_db)) -> list[SchemaRead]:
    schemas = db.query(Schema).order_by(Schema.created_at.desc()).all()
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
        return _schema_recommendation_read(recommendation)
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
        "fields": [field.model_dump() for field in payload.fields] if payload.fields is not None else current["fields"],
    }

    schema.name = next_schema_data["name"]
    schema.display_name = next_schema_data["display_name"]
    schema.description = next_schema_data["description"]
    schema.current_version += 1
    db.add(
        SchemaVersion(
            schema_id=schema.id,
            version=schema.current_version,
            schema_json=json.dumps(next_schema_data, ensure_ascii=False),
        )
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
    result.corrected_output = json.dumps(payload.corrected_output, ensure_ascii=False)
    db.commit()
    db.refresh(result)
    return result_to_dict(result)


@app.get("/api/extraction-results/{result_id}/export")
def export_extraction_result(
    result_id: str,
    format: str = Query(default="json", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
) -> Response:
    result = db.get(ExtractionResult, result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Extraction result not found")

    payload = json.loads(result.corrected_output) if result.corrected_output else json.loads(result.validated_output)
    if format == "json":
        return JSONResponse(payload)

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["key_name", "value", "normalized_value", "page", "confidence", "evidence", "warnings"],
    )
    writer.writeheader()
    for key, value in payload.get("values", {}).items():
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


def _document_read(document: Document) -> DocumentRead:
    return DocumentRead(
        document_id=document.id,
        filename=document.filename,
        mime_type=document.mime_type,
        size_bytes=document.size_bytes,
        page_count=document.page_count,
        status=document.status,
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


def _schema_read(schema: Schema) -> SchemaRead:
    schema_data = _schema_data(schema)
    return SchemaRead(
        id=schema.id,
        name=schema.name,
        display_name=schema.display_name,
        description=schema.description,
        current_version=schema.current_version,
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
