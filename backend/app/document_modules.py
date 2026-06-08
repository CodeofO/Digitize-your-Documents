import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.audit import log_audit_event
from app.concurrency import gather_workflow_limited, run_workflow_blocking
from app.database import SessionLocal
from app.domain.module_job import ModuleJobLifecycle, TERMINAL_MODULE_JOB_STATUSES
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
from app.module_validation import (
    required_overall_from_items as _required_overall_from_items,
    required_raw_items as _required_raw_items,
    validate_classification_output as _validate_classification_output,
    validate_required_field_output as _validate_required_field_output,
)
from app.prompts.required_checker import cropped_required_region_label, full_page_required_label, masked_required_region_label
from app.schemas import ClassCandidate, RequiredFieldItem, SchemaRegion
from app.storage import scratch_dir_for_ref
from app.vlm import (
    check_required_fields_with_vlm,
    check_required_fields_with_vlm_async,
    classify_document_with_vlm,
    classify_document_with_vlm_async,
    format_vlm_exception,
    run_sync_with_vlm_limit_async,
)


_ORIGINAL_CLASSIFY_DOCUMENT_WITH_VLM = classify_document_with_vlm
_ORIGINAL_CHECK_REQUIRED_FIELDS_WITH_VLM = check_required_fields_with_vlm


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
    asyncio.run(run_classification_job_async(job_id))


async def run_classification_job_async(job_id: str) -> None:
    try:
        context = await run_workflow_blocking(_prepare_classification_job, job_id)
        if not context:
            return
        raw_values = await _call_classify_document_with_vlm_async(
            context.classes,
            context.allow_unknown,
            [page.image_path for page in context.document.pages],
        )
        await run_workflow_blocking(_save_classification_result, job_id, context, raw_values)
    except Exception as exc:
        await run_workflow_blocking(_mark_classification_job_failed, job_id, format_vlm_exception(exc))


def run_classification_batch(batch_id: str, job_ids: list[str]) -> None:
    asyncio.run(
        _run_parallel_batch_async(
            job_ids,
            run_classification_job_async,
            _mark_classification_job_failed,
            lambda: _finalize_classification_batch(batch_id),
        ),
    )


def run_required_field_check_job(job_id: str) -> None:
    asyncio.run(run_required_field_check_job_async(job_id))


async def run_required_field_check_job_async(job_id: str) -> None:
    try:
        context = await run_workflow_blocking(_prepare_required_field_job, job_id)
        if not context:
            return
        raw_values = await _check_required_fields_grouped_async(context, job_id)
        await run_workflow_blocking(_save_required_field_result, job_id, context, raw_values)
    except Exception as exc:
        await run_workflow_blocking(_mark_required_field_job_failed, job_id, format_vlm_exception(exc))


def run_required_field_check_batch(batch_id: str, job_ids: list[str]) -> None:
    asyncio.run(
        _run_parallel_batch_async(
            job_ids,
            run_required_field_check_job_async,
            _mark_required_field_job_failed,
            lambda: _finalize_required_field_batch(batch_id),
        ),
    )


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


async def _run_parallel_batch_async(job_ids: list[str], runner, failer, finalizer) -> None:
    if not job_ids:
        await run_workflow_blocking(finalizer)
        return
    try:
        results = await gather_workflow_limited(job_ids, runner, return_exceptions=True)
        for job_id, result in zip(job_ids, results, strict=True):
            if isinstance(result, Exception):
                await run_workflow_blocking(failer, job_id, f"Batch worker failed: {result}")
    except Exception as exc:
        for job_id in job_ids:
            await run_workflow_blocking(failer, job_id, f"Batch worker did not start job: {exc}")
        raise
    finally:
        await run_workflow_blocking(finalizer)


def _run_parallel_batch(job_ids: list[str], runner, failer, finalizer) -> None:
    async def _runner(job_id: str) -> None:
        await run_workflow_blocking(runner, job_id)

    asyncio.run(_run_parallel_batch_async(job_ids, _runner, failer, finalizer))


def _prepare_classification_job(job_id: str) -> ClassificationContext | None:
    db = SessionLocal()
    try:
        job = db.get(ClassificationJob, job_id)
        if not job or job.status != "queued":
            return None
        ModuleJobLifecycle(job).mark_running(datetime.utcnow())
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
        if not job or job.status != "queued":
            return None
        ModuleJobLifecycle(job).mark_running(datetime.utcnow())
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
        ModuleJobLifecycle(job).complete(datetime.utcnow())
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
        if validated["overall_status"] == "needs_review":
            ModuleJobLifecycle(job).needs_review(datetime.utcnow())
        else:
            ModuleJobLifecycle(job).complete(datetime.utcnow())
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


def _check_required_fields_grouped(context: RequiredFieldContext, job_id: str) -> dict[str, Any]:
    return asyncio.run(_check_required_fields_grouped_async(context, job_id))


async def _check_required_fields_grouped_async(context: RequiredFieldContext, job_id: str) -> dict[str, Any]:
    requests = await run_workflow_blocking(_build_required_field_requests, context.document, context.items, context.regions, job_id)
    if not requests:
        return {"overall_status": "complete", "items": []}
    if len(requests) == 1:
        request = requests[0]
        return await _call_check_required_fields_with_vlm_async(request["items"], request["regions"], image_inputs=request["image_inputs"])

    results = await asyncio.gather(
        *[
            _call_check_required_fields_with_vlm_async(
                request["items"],
                request["regions"],
                None,
                request["image_inputs"],
            )
            for request in requests
        ],
    )

    merged_items: list[dict[str, Any]] = []
    for result in results:
        if not result:
            continue
        merged_items.extend(_required_raw_items(result))
    return {"overall_status": _required_overall_from_items(merged_items, context.items), "items": merged_items}


async def _call_classify_document_with_vlm_async(
    classes: list[ClassCandidate],
    allow_unknown: bool,
    image_paths: list[str],
) -> dict[str, Any]:
    if classify_document_with_vlm is not _ORIGINAL_CLASSIFY_DOCUMENT_WITH_VLM:
        return await run_sync_with_vlm_limit_async(classify_document_with_vlm, classes, allow_unknown, image_paths)
    return await classify_document_with_vlm_async(classes, allow_unknown, image_paths)


async def _call_check_required_fields_with_vlm_async(
    items: list[RequiredFieldItem],
    regions: list[SchemaRegion],
    image_paths: list[str] | None = None,
    image_inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    if check_required_fields_with_vlm is not _ORIGINAL_CHECK_REQUIRED_FIELDS_WITH_VLM:
        return await run_sync_with_vlm_limit_async(check_required_fields_with_vlm, items, regions, image_paths=image_paths, image_inputs=image_inputs)
    return await check_required_fields_with_vlm_async(items, regions, image_paths=image_paths, image_inputs=image_inputs)


def _build_required_field_requests(
    document: DocumentSnapshot,
    items: list[RequiredFieldItem],
    regions: list[SchemaRegion],
    job_id: str,
) -> list[dict[str, Any]]:
    region_map = {region.id: region for region in regions}
    full_page_items = [item for item in items if not item.region_id]
    region_items = [item for item in items if item.region_id]
    requests: list[dict[str, Any]] = []

    if full_page_items:
        requests.append(
            {
                "items": full_page_items,
                "regions": [],
                "image_inputs": [
                    {"path": page.image_path, "label": full_page_required_label(page.page_number)}
                    for page in document.pages
                ],
            }
        )

    if not region_items:
        return requests

    page_map = {page.page_number: page for page in document.pages}
    crop_dir = scratch_dir_for_ref(document.storage_path, "required_regions", job_id)
    grouped: dict[str, list[RequiredFieldItem]] = {}
    for item in region_items:
        if item.region_id:
            grouped.setdefault(item.region_id, []).append(item)

    for index, (region_id, grouped_items) in enumerate(grouped.items(), start=1):
        region = region_map.get(region_id)
        if not region:
            raise RuntimeError(f"Required field region {region_id} does not exist")
        page = page_map.get(region.page)
        if not page:
            raise RuntimeError(f"Region page {region.page} does not exist for required field region {region.id}")
        masked_path = _mask_region_image(page, region, crop_dir / f"region_{index}_masked.png")
        crop_path = _crop_region_image(page, region, crop_dir / f"region_{index}_crop.png")
        item_names = [item.item_name for item in grouped_items]
        requests.append(
            {
                "items": grouped_items,
                "regions": [region],
                "image_inputs": [
                    {"path": str(masked_path), "label": masked_required_region_label(region, item_names)},
                    {"path": str(crop_path), "label": cropped_required_region_label(region, item_names)},
                ],
            }
        )

    return requests


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
        ModuleJobLifecycle(job).fail(message, datetime.utcnow())
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
        active = [job for job in jobs if job.status in {"queued", "running", "waiting_for_document"}]
        if active:
            batch.status = "running"
            batch.completed_at = None
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
