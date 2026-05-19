import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.audit import log_audit_event
from app.database import SessionLocal
from app.models import Document, ExtractionJob, ExtractionResult, SchemaVersion
from app.schemas import FieldDefinition
from app.validation import validate_extracted_values
from app.vlm import extract_with_vlm


def run_extraction_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        _run_extraction_job(db, job_id)
    finally:
        db.close()


def _run_extraction_job(db: Session, job_id: str) -> None:
    job = db.get(ExtractionJob, job_id)
    if not job:
        return

    job.status = "running"
    job.started_at = datetime.utcnow()
    db.commit()

    try:
        document = db.get(Document, job.document_id)
        schema_version = (
            db.query(SchemaVersion)
            .filter(
                SchemaVersion.schema_id == job.schema_id,
                SchemaVersion.version == job.schema_version,
            )
            .one_or_none()
        )
        if not document or not schema_version:
            raise RuntimeError("Document or schema version not found")

        schema_data = json.loads(schema_version.schema_json)
        fields = [FieldDefinition(**field) for field in schema_data["fields"]]
        image_paths = [page.image_path for page in document.pages]

        raw_values = extract_with_vlm(fields, image_paths)
        values, warnings = validate_extracted_values(raw_values, fields)
        validated_output = {
            "document_id": document.id,
            "schema_id": job.schema_id,
            "schema_version": job.schema_version,
            "status": "needs_review" if warnings else "completed",
            "values": values,
        }

        result = ExtractionResult(
            job_id=job.id,
            raw_model_output=json.dumps(raw_values, ensure_ascii=False),
            validated_output=json.dumps(validated_output, ensure_ascii=False),
            validation_warnings=json.dumps(warnings, ensure_ascii=False),
        )
        db.add(result)
        db.flush()

        job.result_id = result.id
        job.status = "needs_review" if warnings else "completed"
        job.completed_at = datetime.utcnow()
        log_audit_event(
            db,
            entity_type="extraction_job",
            entity_id=job.id,
            action=job.status,
            message="Extraction completed" if job.status == "completed" else "Extraction completed with review warnings",
            metadata={"result_id": result.id, "warning_count": len(warnings)},
        )
        db.commit()
    except Exception as exc:
        job.status = "failed"
        job.error_message = str(exc)
        job.completed_at = datetime.utcnow()
        log_audit_event(
            db,
            entity_type="extraction_job",
            entity_id=job.id,
            action="failed",
            message=str(exc),
            metadata={"document_id": job.document_id, "schema_id": job.schema_id},
        )
        db.commit()


def result_to_dict(result: ExtractionResult) -> dict[str, Any]:
    return {
        "id": result.id,
        "job_id": result.job_id,
        "raw_model_output": json.loads(result.raw_model_output),
        "validated_output": json.loads(result.validated_output),
        "corrected_output": json.loads(result.corrected_output) if result.corrected_output else None,
        "validation_warnings": json.loads(result.validation_warnings),
        "reviewed_fields": json.loads(result.reviewed_fields),
        "created_at": result.created_at,
        "updated_at": result.updated_at,
    }
