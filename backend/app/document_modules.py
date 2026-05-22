import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.audit import log_audit_event
from app.config import get_settings
from app.database import SessionLocal
from app.extraction import DocumentPageSnapshot, DocumentSnapshot, _crop_region_image, _mask_region_image
from app.models import (
    ClassificationBatch,
    ClassificationJob,
    ClassificationResult,
    Document,
    DocumentClassifier,
    RequiredFieldCheckBatch,
    RequiredFieldCheckJob,
    RequiredFieldCheckResult,
    RequiredFieldChecklist,
)
from app.schemas import ClassCandidate, RequiredFieldItem, SchemaRegion
from app.vlm import classify_document_with_vlm, check_required_fields_with_vlm, format_vlm_exception


TERMINAL_MODULE_JOB_STATUSES = {"completed", "needs_review", "failed", "canceled"}


@dataclass(frozen=True)
class ClassificationContext:
    document: DocumentSnapshot
    classifier_id: str
    classes: list[ClassCandidate]
    allow_unknown: bool


@dataclass(frozen=True)
class RequiredFieldContext:
    document: DocumentSnapshot
    checklist_id: str
    items: list[RequiredFieldItem]
    regions: list[SchemaRegion]


def run_classification_job(job_id: str) -> None:
    try:
        context = _prepare_classification_job(job_id)
        if not context:
            return
        raw_values = classify_document_with_vlm(
            context.classes,
            context.allow_unknown,
            [page.image_path for page in context.document.pages],
        )
        _save_classification_result(job_id, context, raw_values)
    except Exception as exc:
        _mark_classification_job_failed(job_id, format_vlm_exception(exc))


def run_classification_batch(batch_id: str, job_ids: list[str]) -> None:
    _run_parallel_batch(job_ids, run_classification_job, _mark_classification_job_failed, lambda: _finalize_classification_batch(batch_id))


def run_required_field_check_job(job_id: str) -> None:
    try:
        context = _prepare_required_field_job(job_id)
        if not context:
            return
        raw_values = check_required_fields_with_vlm(
            context.items,
            context.regions,
            image_inputs=_required_field_image_inputs(context.document, context.items, context.regions, job_id),
        )
        _save_required_field_result(job_id, context, raw_values)
    except Exception as exc:
        _mark_required_field_job_failed(job_id, format_vlm_exception(exc))


def run_required_field_check_batch(batch_id: str, job_ids: list[str]) -> None:
    _run_parallel_batch(job_ids, run_required_field_check_job, _mark_required_field_job_failed, lambda: _finalize_required_field_batch(batch_id))


def classification_result_to_dict(result: ClassificationResult) -> dict[str, Any]:
    return {
        "id": result.id,
        "job_id": result.job_id,
        "raw_model_output": json.loads(result.raw_model_output),
        "validated_output": json.loads(result.validated_output),
        "corrected_output": json.loads(result.corrected_output) if result.corrected_output else None,
        "reviewed": result.reviewed,
        "created_at": result.created_at,
        "updated_at": result.updated_at,
    }


def required_field_result_to_dict(result: RequiredFieldCheckResult) -> dict[str, Any]:
    return {
        "id": result.id,
        "job_id": result.job_id,
        "raw_model_output": json.loads(result.raw_model_output),
        "validated_output": json.loads(result.validated_output),
        "corrected_output": json.loads(result.corrected_output) if result.corrected_output else None,
        "reviewed": result.reviewed,
        "created_at": result.created_at,
        "updated_at": result.updated_at,
    }


def _run_parallel_batch(job_ids: list[str], runner, failer, finalizer) -> None:
    if not job_ids:
        finalizer()
        return
    max_workers = max(1, min(get_settings().batch_max_workers, len(job_ids)))
    submitted_job_ids: set[str] = set()
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for job_id in job_ids:
                future = executor.submit(runner, job_id)
                futures[future] = job_id
                submitted_job_ids.add(job_id)
            for future in as_completed(futures):
                job_id = futures[future]
                try:
                    future.result()
                except Exception as exc:
                    failer(job_id, f"Batch worker failed: {exc}")
    except Exception as exc:
        for job_id in set(job_ids) - submitted_job_ids:
            failer(job_id, f"Batch worker did not start job: {exc}")
        raise
    finally:
        finalizer()


def _prepare_classification_job(job_id: str) -> ClassificationContext | None:
    db = SessionLocal()
    try:
        job = db.get(ClassificationJob, job_id)
        if not job or job.status == "canceled":
            return None
        job.status = "running"
        job.started_at = datetime.utcnow()
        db.commit()
        document = db.get(Document, job.document_id)
        classifier = db.get(DocumentClassifier, job.classifier_id)
        if not document or not classifier:
            raise RuntimeError("Document or classifier not found")
        config = json.loads(classifier.config_json or "{}")
        classes = [ClassCandidate(**item) for item in config.get("classes", [])]
        pages = _document_pages_snapshot(document)
        return ClassificationContext(
            document=DocumentSnapshot(id=document.id, storage_path=document.storage_path, pages=pages),
            classifier_id=classifier.id,
            classes=classes,
            allow_unknown=bool(config.get("allow_unknown", classifier.allow_unknown)),
        )
    finally:
        db.close()


def _prepare_required_field_job(job_id: str) -> RequiredFieldContext | None:
    db = SessionLocal()
    try:
        job = db.get(RequiredFieldCheckJob, job_id)
        if not job or job.status == "canceled":
            return None
        job.status = "running"
        job.started_at = datetime.utcnow()
        db.commit()
        document = db.get(Document, job.document_id)
        checklist = db.get(RequiredFieldChecklist, job.checklist_id)
        if not document or not checklist:
            raise RuntimeError("Document or checklist not found")
        config = json.loads(checklist.config_json or "{}")
        items = [RequiredFieldItem(**item) for item in config.get("items", [])]
        regions = [SchemaRegion(**region) for region in config.get("regions", [])]
        pages = _document_pages_snapshot(document)
        return RequiredFieldContext(
            document=DocumentSnapshot(id=document.id, storage_path=document.storage_path, pages=pages),
            checklist_id=checklist.id,
            items=items,
            regions=regions,
        )
    finally:
        db.close()


def _document_pages_snapshot(document: Document) -> list[DocumentPageSnapshot]:
    return [
        DocumentPageSnapshot(page_number=page.page_number, image_path=page.image_path)
        for page in sorted(document.pages, key=lambda item: item.page_number)
    ]


def _save_classification_result(job_id: str, context: ClassificationContext, raw_values: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        job = db.get(ClassificationJob, job_id)
        if not job or job.status == "canceled":
            db.commit()
            return
        validated = _validate_classification_output(raw_values, context)
        result = ClassificationResult(
            job_id=job.id,
            raw_model_output=json.dumps(raw_values, ensure_ascii=False),
            validated_output=json.dumps(validated, ensure_ascii=False),
        )
        db.add(result)
        db.flush()
        job.result_id = result.id
        job.status = validated["status"] if validated["status"] == "needs_review" else "completed"
        job.completed_at = datetime.utcnow()
        log_audit_event(
            db,
            entity_type="classification_job",
            entity_id=job.id,
            action=job.status,
            message="Document classification completed",
            metadata={"result_id": result.id, "classifier_id": context.classifier_id},
        )
        db.commit()
    finally:
        db.close()


def _save_required_field_result(job_id: str, context: RequiredFieldContext, raw_values: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        job = db.get(RequiredFieldCheckJob, job_id)
        if not job or job.status == "canceled":
            db.commit()
            return
        validated = _validate_required_field_output(raw_values, context)
        result = RequiredFieldCheckResult(
            job_id=job.id,
            raw_model_output=json.dumps(raw_values, ensure_ascii=False),
            validated_output=json.dumps(validated, ensure_ascii=False),
        )
        db.add(result)
        db.flush()
        job.result_id = result.id
        job.status = "needs_review" if validated["overall_status"] == "needs_review" else "completed"
        job.completed_at = datetime.utcnow()
        log_audit_event(
            db,
            entity_type="required_field_check_job",
            entity_id=job.id,
            action=job.status,
            message="Required field check completed",
            metadata={"result_id": result.id, "checklist_id": context.checklist_id},
        )
        db.commit()
    finally:
        db.close()


def _validate_classification_output(raw_values: dict[str, Any], context: ClassificationContext) -> dict[str, Any]:
    class_names = {item.class_name for item in context.classes}
    status = raw_values.get("status") if raw_values.get("status") in {"classified", "unknown", "needs_review"} else "needs_review"
    class_name = raw_values.get("class_name")
    if status == "classified" and class_name not in class_names:
        status = "needs_review"
        class_name = None
    if status == "unknown":
        class_name = None
    if status == "unknown" and not context.allow_unknown:
        status = "needs_review"
    confidence = raw_values.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = None
    evidence = raw_values.get("evidence")
    return {
        "document_id": context.document.id,
        "classifier_id": context.classifier_id,
        "status": status,
        "class_name": class_name if isinstance(class_name, str) else None,
        "confidence": max(0, min(1, float(confidence))) if confidence is not None else None,
        "reason": str(raw_values.get("reason") or ""),
        "evidence": evidence if isinstance(evidence, list) else [],
    }


def _validate_required_field_output(raw_values: dict[str, Any], context: RequiredFieldContext) -> dict[str, Any]:
    raw_items = raw_values.get("items") if isinstance(raw_values.get("items"), list) else []
    raw_by_name = {item.get("item_name"): item for item in raw_items if isinstance(item, dict)}
    items: list[dict[str, Any]] = []
    needs_review = False
    incomplete = False
    for configured in context.items:
        raw_item = raw_by_name.get(configured.item_name, {})
        status = raw_item.get("status")
        if status not in {"present", "missing", "uncertain", "not_applicable"}:
            status = "uncertain"
        if configured.required and status == "missing":
            incomplete = True
        if configured.required and status == "uncertain":
            needs_review = True
        confidence = raw_item.get("confidence")
        if not isinstance(confidence, (int, float)):
            confidence = None
        page = raw_item.get("page")
        items.append(
            {
                "item_name": configured.item_name,
                "status": status,
                "required": configured.required,
                "evidence_type": configured.evidence_type,
                "confidence": max(0, min(1, float(confidence))) if confidence is not None else None,
                "evidence": raw_item.get("evidence") if isinstance(raw_item.get("evidence"), str) else None,
                "page": page if isinstance(page, int) else None,
            }
        )
    overall_status = "needs_review" if needs_review else "incomplete" if incomplete else "complete"
    return {
        "document_id": context.document.id,
        "checklist_id": context.checklist_id,
        "overall_status": overall_status,
        "items": items,
    }


def _mark_classification_job_failed(job_id: str, message: str) -> None:
    _mark_module_job_failed(ClassificationJob, "classification_job", job_id, message)


def _mark_required_field_job_failed(job_id: str, message: str) -> None:
    _mark_module_job_failed(RequiredFieldCheckJob, "required_field_check_job", job_id, message)


def _mark_module_job_failed(model, entity_type: str, job_id: str, message: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(model, job_id)
        if not job or job.status in TERMINAL_MODULE_JOB_STATUSES:
            return
        job.status = "failed"
        job.error_message = message
        job.completed_at = datetime.utcnow()
        log_audit_event(db, entity_type=entity_type, entity_id=job.id, action="failed", message=message, metadata={})
        db.commit()
    finally:
        db.close()


def _finalize_classification_batch(batch_id: str) -> None:
    _finalize_module_batch(ClassificationBatch, batch_id)


def _finalize_required_field_batch(batch_id: str) -> None:
    _finalize_module_batch(RequiredFieldCheckBatch, batch_id)


def _finalize_module_batch(model, batch_id: str) -> None:
    db = SessionLocal()
    try:
        batch = db.get(model, batch_id)
        if not batch:
            return
        jobs = [item.job for item in batch.items if item.job]
        if not jobs:
            batch.status = "failed"
            batch.completed_at = datetime.utcnow()
            db.commit()
            return
        for job in [job for job in jobs if job.status not in TERMINAL_MODULE_JOB_STATUSES]:
            job.status = "failed"
            job.error_message = "Batch worker finished before this job reached a terminal status"
            job.completed_at = datetime.utcnow()
        statuses = [job.status for job in jobs]
        if all(status == "canceled" for status in statuses):
            next_status = "canceled"
        elif any(status in {"failed", "canceled"} for status in statuses):
            next_status = "completed_with_errors"
        else:
            next_status = "completed"
        batch.status = next_status
        batch.completed_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


def _required_field_image_inputs(
    document: DocumentSnapshot,
    items: list[RequiredFieldItem],
    regions: list[SchemaRegion],
    job_id: str,
) -> list[dict[str, str]]:
    inputs = [
        {"path": page.image_path, "label": f"Full document page {page.page_number} for required field checking."}
        for page in document.pages
    ]
    region_ids = {item.region_id for item in items if item.region_id}
    if not region_ids:
        return inputs
    page_map = {page.page_number: page for page in document.pages}
    crop_dir = Path(document.storage_path).parent / "required_regions" / job_id
    crop_dir.mkdir(parents=True, exist_ok=True)
    for index, region in enumerate([region for region in regions if region.id in region_ids]):
        page = page_map.get(region.page)
        if not page:
            raise RuntimeError(f"Region page {region.page} does not exist for required field region {region.id}")
        masked_path = _mask_region_image(page, region, crop_dir / f"region_{index + 1}_masked.png")
        crop_path = _crop_region_image(page, region, crop_dir / f"region_{index + 1}_crop.png")
        item_names = [item.item_name for item in items if item.region_id == region.id]
        inputs.extend(
            [
                {
                    "path": str(masked_path),
                    "label": f"Masked context for required field region '{region.name}' on page {region.page}. Use for: {', '.join(item_names)}.",
                },
                {
                    "path": str(crop_path),
                    "label": f"Cropped required field region '{region.name}' on page {region.page}. Use as primary visual evidence for: {', '.join(item_names)}.",
                },
            ]
        )
    return inputs
