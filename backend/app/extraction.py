import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from app.audit import log_audit_event
from app.concurrency import gather_workflow_limited, run_workflow_blocking
from app.config import get_settings
from app.database import SessionLocal
from app.models import Document, ExtractionJob, ExtractionResult, Schema
from app.schemas import FieldDefinition, FieldRegion, SchemaRegion
from app.storage import materialize_storage_ref, scratch_dir_for_ref
from app.validation import validate_extracted_values
from app.vlm import (
    correct_extraction_with_vlm,
    correct_extraction_with_vlm_async,
    extract_with_vlm,
    extract_with_vlm_async,
    format_vlm_exception,
    judge_extraction_with_vlm,
    judge_extraction_with_vlm_async,
    run_sync_with_vlm_limit_async,
)


_ORIGINAL_EXTRACT_WITH_VLM = extract_with_vlm
_ORIGINAL_JUDGE_EXTRACTION_WITH_VLM = judge_extraction_with_vlm
_ORIGINAL_CORRECT_EXTRACTION_WITH_VLM = correct_extraction_with_vlm


TERMINAL_JOB_STATUSES = {"completed", "needs_review", "failed", "canceled"}
MIN_AI_CORRECTION_CONFIDENCE = 0.85
MIN_HANGUL_CORRECTION_SIMILARITY = 0.65


@dataclass(frozen=True)
class DocumentPageSnapshot:
    page_number: int
    image_path: str


@dataclass(frozen=True)
class DocumentSnapshot:
    id: str
    storage_path: str
    pages: list[DocumentPageSnapshot]


@dataclass(frozen=True)
class ExtractionContext:
    document: DocumentSnapshot
    schema_id: str
    fields: list[FieldDefinition]
    regions: list[SchemaRegion]


def run_extraction_job(job_id: str) -> None:
    asyncio.run(run_extraction_job_async(job_id))


_ORIGINAL_RUN_EXTRACTION_JOB = run_extraction_job


async def run_extraction_job_async(job_id: str) -> None:
    try:
        context = await run_workflow_blocking(_prepare_extraction_job, job_id)
        if not context:
            return
        raw_values = await _extract_grouped_values_async(context.document, context.fields, context.regions, job_id)
        values, warnings = validate_extracted_values(raw_values, context.fields)
        values, warnings = await _apply_ai_judgement_async(context.document, context.fields, context.regions, job_id, values, warnings)
        await run_workflow_blocking(_save_extraction_result, job_id, context, raw_values, values, warnings)
    except Exception as exc:
        await run_workflow_blocking(_mark_job_failed, job_id, format_vlm_exception(exc))


def run_batch_jobs(batch_id: str, job_ids: list[str]) -> None:
    asyncio.run(run_batch_jobs_async(batch_id, job_ids))


async def run_batch_jobs_async(batch_id: str, job_ids: list[str]) -> None:
    if not job_ids:
        await run_workflow_blocking(_finalize_batch, batch_id)
        return
    try:
        results = await gather_workflow_limited(job_ids, _run_batch_extraction_job_async, return_exceptions=True)
        for job_id, result in zip(job_ids, results, strict=True):
            if isinstance(result, Exception):
                await run_workflow_blocking(_mark_job_failed, job_id, f"Batch worker failed: {result}")
    except Exception as exc:
        for job_id in job_ids:
            await run_workflow_blocking(_mark_job_failed, job_id, f"Batch worker did not start job: {exc}")
        raise
    finally:
        await run_workflow_blocking(_finalize_batch, batch_id)


async def _run_batch_extraction_job_async(job_id: str) -> None:
    if run_extraction_job is not _ORIGINAL_RUN_EXTRACTION_JOB:
        await run_workflow_blocking(run_extraction_job, job_id)
        return
    await run_extraction_job_async(job_id)


def _prepare_extraction_job(job_id: str) -> ExtractionContext | None:
    db = SessionLocal()
    try:
        job = db.get(ExtractionJob, job_id)
        if not job:
            return None
        if job.status != "queued":
            return None

        job.status = "running"
        job.started_at = datetime.utcnow()
        db.commit()
        document = db.get(Document, job.document_id)
        schema = db.get(Schema, job.schema_id)
        if not document or not schema:
            raise RuntimeError("Document or schema not found")
        if not schema.schema_json or schema.schema_json == "{}":
            raise RuntimeError("Schema data is missing")

        schema_data = json.loads(schema.schema_json)
        fields = [FieldDefinition(**field) for field in schema_data["fields"]]
        regions = [SchemaRegion(**region) for region in schema_data.get("regions", [])]
        pages = [
            DocumentPageSnapshot(page_number=page.page_number, image_path=page.image_path)
            for page in sorted(document.pages, key=lambda item: item.page_number)
        ]
        return ExtractionContext(
            document=DocumentSnapshot(id=document.id, storage_path=document.storage_path, pages=pages),
            schema_id=job.schema_id,
            fields=fields,
            regions=regions,
        )
    finally:
        db.close()


def _save_extraction_result(
    job_id: str,
    context: ExtractionContext,
    raw_values: dict[str, Any],
    values: dict[str, dict[str, Any]],
    warnings: list[str],
) -> None:
    db = SessionLocal()
    try:
        job = db.get(ExtractionJob, job_id)
        if not job:
            return
        if job.status == "canceled":
            log_audit_event(
                db,
                entity_type="extraction_job",
                entity_id=job.id,
                action="canceled",
                message="Extraction job was canceled before saving VLM output",
                metadata={"document_id": job.document_id, "schema_id": job.schema_id},
            )
            db.commit()
            return

        validated_output = {
            "document_id": context.document.id,
            "schema_id": context.schema_id,
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
    finally:
        db.close()


def _apply_ai_judgement(
    document: DocumentSnapshot,
    fields: list[FieldDefinition],
    regions: list[SchemaRegion],
    job_id: str,
    values: dict[str, dict[str, Any]],
    warnings: list[str],
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    review_fields = [field for field in fields if field.judgement_enabled]
    if not review_fields:
        return values, warnings

    inputs_by_field = _build_judgement_inputs(document, review_fields, regions, job_id)
    next_values = dict(values)
    next_warnings = list(warnings)

    for field in review_fields:
        current = dict(next_values.get(field.key_name, {}))
        initial_value = current.get("value")
        initial_evidence = current.get("evidence") if isinstance(current.get("evidence"), str) else None
        image_inputs = inputs_by_field.get(field.key_name)
        ai_review: dict[str, Any] = {
            "enabled": True,
            "mode": "region" if field.region_id or field.region is not None else "full_page",
            "judgement_status": "failed",
            "judgement_reason": None,
            "judgement_confidence": None,
            "initial_value": initial_value,
            "initial_evidence": initial_evidence,
            "corrected": False,
            "correction_reason": None,
        }

        if not image_inputs:
            _append_field_warning(current, next_warnings, field.key_name, "ai_review_failed")
            ai_review["judgement_reason"] = "AI review images could not be prepared."
            current["ai_review"] = ai_review
            next_values[field.key_name] = current
            continue

        try:
            judgement = judge_extraction_with_vlm(field, initial_value, initial_evidence, image_inputs)
            status = judgement.get("judgement_status")
            if status not in {"correct", "needs_correction"}:
                raise RuntimeError(f"Unsupported judgement_status: {status}")
            ai_review["judgement_status"] = status
            ai_review["judgement_reason"] = str(judgement.get("reason") or "")
            confidence = judgement.get("confidence")
            ai_review["judgement_confidence"] = float(confidence) if isinstance(confidence, (int, float)) else None
            if status == "needs_correction":
                correction = correct_extraction_with_vlm(field, initial_value, initial_evidence, ai_review["judgement_reason"], image_inputs)
                corrected_values, correction_warnings = validate_extracted_values({field.key_name: correction}, [field])
                corrected_entry = dict(corrected_values[field.key_name])
                rejection_warning = _correction_rejection_warning(initial_value, corrected_entry)
                if rejection_warning:
                    ai_review["correction_reason"] = _correction_rejection_reason(rejection_warning, correction)
                    _append_field_warning(current, next_warnings, field.key_name, rejection_warning)
                    current["ai_review"] = ai_review
                    next_values[field.key_name] = current
                    continue
                corrected_entry["ai_review"] = {
                    **ai_review,
                    "corrected": True,
                    "correction_reason": str(correction.get("correction_reason") or ""),
                }
                next_values[field.key_name] = corrected_entry
                next_warnings = [warning for warning in next_warnings if not warning.startswith(f"{field.key_name}:")]
                next_warnings.extend(correction_warnings)
                continue
        except Exception as exc:
            warning = "ai_correction_failed" if ai_review["judgement_status"] == "needs_correction" else "ai_review_failed"
            _append_field_warning(current, next_warnings, field.key_name, warning)
            if warning == "ai_correction_failed":
                ai_review["correction_reason"] = str(exc)
            else:
                ai_review["judgement_reason"] = str(exc)
            ai_review["judgement_status"] = "failed"

        current["ai_review"] = ai_review
        next_values[field.key_name] = current

    return next_values, next_warnings


async def _apply_ai_judgement_async(
    document: DocumentSnapshot,
    fields: list[FieldDefinition],
    regions: list[SchemaRegion],
    job_id: str,
    values: dict[str, dict[str, Any]],
    warnings: list[str],
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    review_fields = [field for field in fields if field.judgement_enabled]
    if not review_fields:
        return values, warnings

    inputs_by_field = await run_workflow_blocking(_build_judgement_inputs, document, review_fields, regions, job_id)
    results = await asyncio.gather(
        *[
            _apply_single_field_judgement_async(field, dict(values.get(field.key_name, {})), inputs_by_field.get(field.key_name))
            for field in review_fields
        ],
    )
    next_values = dict(values)
    next_warnings = list(warnings)
    for field_name, entry, field_warnings, remove_existing_warnings in results:
        next_values[field_name] = entry
        if remove_existing_warnings:
            next_warnings = [warning for warning in next_warnings if not warning.startswith(f"{field_name}:")]
        next_warnings.extend(field_warnings)
    return next_values, next_warnings


async def _apply_single_field_judgement_async(
    field: FieldDefinition,
    current: dict[str, Any],
    image_inputs: list[dict[str, str]] | None,
) -> tuple[str, dict[str, Any], list[str], bool]:
    local_warnings: list[str] = []
    initial_value = current.get("value")
    initial_evidence = current.get("evidence") if isinstance(current.get("evidence"), str) else None
    ai_review: dict[str, Any] = {
        "enabled": True,
        "mode": "region" if field.region_id or field.region is not None else "full_page",
        "judgement_status": "failed",
        "judgement_reason": None,
        "judgement_confidence": None,
        "initial_value": initial_value,
        "initial_evidence": initial_evidence,
        "corrected": False,
        "correction_reason": None,
    }

    if not image_inputs:
        _append_field_warning(current, local_warnings, field.key_name, "ai_review_failed")
        ai_review["judgement_reason"] = "AI review images could not be prepared."
        current["ai_review"] = ai_review
        return field.key_name, current, local_warnings, False

    try:
        judgement = await _call_judge_extraction_with_vlm_async(field, initial_value, initial_evidence, image_inputs)
        status = judgement.get("judgement_status")
        if status not in {"correct", "needs_correction"}:
            raise RuntimeError(f"Unsupported judgement_status: {status}")
        ai_review["judgement_status"] = status
        ai_review["judgement_reason"] = str(judgement.get("reason") or "")
        confidence = judgement.get("confidence")
        ai_review["judgement_confidence"] = float(confidence) if isinstance(confidence, (int, float)) else None
        if status == "needs_correction":
            correction = await _call_correct_extraction_with_vlm_async(field, initial_value, initial_evidence, ai_review["judgement_reason"], image_inputs)
            corrected_values, correction_warnings = validate_extracted_values({field.key_name: correction}, [field])
            corrected_entry = dict(corrected_values[field.key_name])
            rejection_warning = _correction_rejection_warning(initial_value, corrected_entry)
            if rejection_warning:
                ai_review["correction_reason"] = _correction_rejection_reason(rejection_warning, correction)
                _append_field_warning(current, local_warnings, field.key_name, rejection_warning)
                current["ai_review"] = ai_review
                return field.key_name, current, local_warnings, False
            corrected_entry["ai_review"] = {
                **ai_review,
                "corrected": True,
                "correction_reason": str(correction.get("correction_reason") or ""),
            }
            return field.key_name, corrected_entry, correction_warnings, True
    except Exception as exc:
        warning = "ai_correction_failed" if ai_review["judgement_status"] == "needs_correction" else "ai_review_failed"
        _append_field_warning(current, local_warnings, field.key_name, warning)
        if warning == "ai_correction_failed":
            ai_review["correction_reason"] = str(exc)
        else:
            ai_review["judgement_reason"] = str(exc)
        ai_review["judgement_status"] = "failed"

    current["ai_review"] = ai_review
    return field.key_name, current, local_warnings, False


def _correction_rejection_warning(initial_value: Any, corrected_entry: dict[str, Any]) -> str | None:
    corrected_value = corrected_entry.get("value")
    confidence = corrected_entry.get("confidence")
    if _has_value(initial_value) and corrected_value is None:
        return "ai_correction_discarded_null"
    if isinstance(confidence, (int, float)) and confidence < MIN_AI_CORRECTION_CONFIDENCE:
        return "ai_correction_low_confidence"
    if _hangul_correction_changed_too_much(initial_value, corrected_value):
        return "ai_correction_large_change"
    return None


def _correction_rejection_reason(warning: str, correction: dict[str, Any]) -> str:
    reason = str(correction.get("correction_reason") or "").strip() if isinstance(correction, dict) else ""
    labels = {
        "ai_correction_discarded_null": "Discarded correction because it would replace a non-empty first-stage value with null.",
        "ai_correction_low_confidence": "Discarded correction because its confidence was below the automatic-apply threshold.",
        "ai_correction_large_change": "Discarded correction because it changed a short Hangul value too aggressively.",
    }
    return f"{labels.get(warning, 'Discarded correction.')} {reason}".strip()


def _has_value(value: Any) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _hangul_correction_changed_too_much(initial_value: Any, corrected_value: Any) -> bool:
    if not isinstance(initial_value, str) or not isinstance(corrected_value, str):
        return False
    initial = _compact_value(initial_value)
    corrected = _compact_value(corrected_value)
    if not initial or not corrected or initial == corrected:
        return False
    if not (_contains_hangul(initial) or _contains_hangul(corrected)):
        return False
    if max(len(initial), len(corrected)) > 8:
        return False
    similarity = SequenceMatcher(None, initial, corrected).ratio()
    return similarity < MIN_HANGUL_CORRECTION_SIMILARITY


def _compact_value(value: str) -> str:
    return "".join(value.split())


def _contains_hangul(value: str) -> bool:
    return any("\uac00" <= character <= "\ud7a3" or "\u3131" <= character <= "\u318e" for character in value)


def _append_field_warning(entry: dict[str, Any], warnings: list[str], field_name: str, warning: str) -> None:
    field_warnings = entry.get("warnings")
    if not isinstance(field_warnings, list):
        field_warnings = []
    if warning not in field_warnings:
        field_warnings.append(warning)
    entry["warnings"] = field_warnings
    warnings.append(f"{field_name}:{warning}")


def _build_judgement_inputs(
    document: DocumentSnapshot,
    fields: list[FieldDefinition],
    regions: list[SchemaRegion],
    job_id: str,
) -> dict[str, list[dict[str, str]]]:
    page_map = {page.page_number: page for page in document.pages}
    region_map = {region.id: region for region in regions}
    field_region_refs = _field_region_refs(fields, region_map)
    crop_dir = scratch_dir_for_ref(document.storage_path, "judgement_regions", job_id)
    inputs_by_field: dict[str, list[dict[str, str]]] = {}

    for index, field in enumerate(fields, start=1):
        region_ref = field_region_refs.get(field.key_name)
        if not region_ref:
            inputs_by_field[field.key_name] = [
                {
                    "path": page.image_path,
                    "label": f"Full document page {page.page_number} for second-stage KIE judgement of field '{field.key_name}'.",
                }
                for page in document.pages
            ]
            continue

        region = region_ref["region"]
        page = page_map.get(region.page)
        if not page:
            continue
        crop_path = _crop_region_image(page, region, crop_dir / f"field_{index}_crop.png")
        inputs_by_field[field.key_name] = [
            {
                "path": page.image_path,
                "label": (
                    f"Full page context for second-stage KIE judgement of field '{field.key_name}' "
                    f"in region '{region_ref['label']}' on page {region.page}."
                ),
            },
            {
                "path": str(crop_path),
                "label": (
                    f"Cropped region '{region_ref['label']}' on page {region.page} for second-stage KIE judgement of field '{field.key_name}'. "
                    "This crop is already the user-designated region from the original page."
                ),
            },
        ]
    return inputs_by_field


def _mark_job_failed(job_id: str, message: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(ExtractionJob, job_id)
        if not job or job.status in TERMINAL_JOB_STATUSES:
            return
        job.status = "failed"
        job.error_message = message
        job.completed_at = datetime.utcnow()
        log_audit_event(
            db,
            entity_type="extraction_job",
            entity_id=job.id,
            action="failed",
            message=message,
            metadata={"document_id": job.document_id, "schema_id": job.schema_id},
        )
        db.commit()
    finally:
        db.close()


def _finalize_batch(batch_id: str) -> None:
    from app.models import Batch

    db = SessionLocal()
    try:
        batch = db.get(Batch, batch_id)
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

        unfinished = [job for job in jobs if job.status not in TERMINAL_JOB_STATUSES]
        for job in unfinished:
            job.status = "failed"
            job.error_message = "Batch worker finished before this job reached a terminal status"
            job.completed_at = datetime.utcnow()
            log_audit_event(
                db,
                entity_type="extraction_job",
                entity_id=job.id,
                action="failed",
                message=job.error_message,
                metadata={"document_id": job.document_id, "schema_id": job.schema_id},
            )

        statuses = [job.status for job in jobs]
        failed_or_canceled = any(status in {"failed", "canceled"} for status in statuses)
        if all(status == "canceled" for status in statuses):
            next_status = "canceled"
        elif failed_or_canceled:
            next_status = "completed_with_errors"
        else:
            next_status = "completed"

        if batch.status != next_status or batch.completed_at is None:
            batch.status = next_status
            batch.completed_at = datetime.utcnow()
            log_audit_event(
                db,
                entity_type="batch",
                entity_id=batch.id,
                action=next_status,
                message=f"Batch finished with status {next_status}",
                metadata={"total_count": batch.total_count},
            )
        db.commit()
    finally:
        db.close()


def _extract_grouped_values(
    document: DocumentSnapshot,
    fields: list[FieldDefinition],
    regions: list[SchemaRegion],
    job_id: str,
) -> dict[str, Any]:
    return asyncio.run(_extract_grouped_values_async(document, fields, regions, job_id))


async def _extract_grouped_values_async(
    document: DocumentSnapshot,
    fields: list[FieldDefinition],
    regions: list[SchemaRegion],
    job_id: str,
) -> dict[str, Any]:
    requests = await run_workflow_blocking(_build_extraction_requests, document, fields, regions, job_id)
    if not requests:
        return {}
    if len(requests) == 1:
        return await _call_extract_with_vlm_async(requests[0]["fields"], image_inputs=requests[0]["image_inputs"])

    results = await asyncio.gather(
        *[
            _call_extract_with_vlm_async(request["fields"], image_inputs=request["image_inputs"])
            for request in requests
        ],
    )
    merged: dict[str, Any] = {}
    for group_values in results:
        if not group_values:
            continue
        for key, value in group_values.items():
            merged[key] = value
    return merged


async def _call_extract_with_vlm_async(
    fields: list[FieldDefinition],
    image_paths: list[str] | None = None,
    image_inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    if extract_with_vlm is not _ORIGINAL_EXTRACT_WITH_VLM:
        if image_paths is None:
            return await run_sync_with_vlm_limit_async(extract_with_vlm, fields, image_inputs=image_inputs)
        return await run_sync_with_vlm_limit_async(extract_with_vlm, fields, image_paths=image_paths, image_inputs=image_inputs)
    return await extract_with_vlm_async(fields, image_paths=image_paths, image_inputs=image_inputs)


async def _call_judge_extraction_with_vlm_async(
    field: FieldDefinition,
    initial_value: Any,
    initial_evidence: str | None,
    image_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    if judge_extraction_with_vlm is not _ORIGINAL_JUDGE_EXTRACTION_WITH_VLM:
        return await run_sync_with_vlm_limit_async(judge_extraction_with_vlm, field, initial_value, initial_evidence, image_inputs)
    return await judge_extraction_with_vlm_async(field, initial_value, initial_evidence, image_inputs)


async def _call_correct_extraction_with_vlm_async(
    field: FieldDefinition,
    initial_value: Any,
    initial_evidence: str | None,
    judgement_reason: str | None,
    image_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    if correct_extraction_with_vlm is not _ORIGINAL_CORRECT_EXTRACTION_WITH_VLM:
        return await run_sync_with_vlm_limit_async(correct_extraction_with_vlm, field, initial_value, initial_evidence, judgement_reason, image_inputs)
    return await correct_extraction_with_vlm_async(field, initial_value, initial_evidence, judgement_reason, image_inputs)


def _build_extraction_requests(
    document: DocumentSnapshot,
    fields: list[FieldDefinition],
    regions: list[SchemaRegion],
    job_id: str,
) -> list[dict[str, Any]]:
    page_map = {page.page_number: page for page in document.pages}
    region_map = {region.id: region for region in regions}
    field_region_refs = _field_region_refs(fields, region_map)
    full_page_fields = [field for field in fields if field.key_name not in field_region_refs]
    requests: list[dict[str, Any]] = []
    field_group_size = max(1, get_settings().kie_field_group_size)

    if full_page_fields:
        for group_index, field_group in enumerate(_chunk_fields(full_page_fields, field_group_size), start=1):
            requests.append(
                {
                    "group_id": f"full_page_{group_index}",
                    "fields": field_group,
                    "image_inputs": [
                        {
                            "path": page.image_path,
                            "label": "Full document page "
                            f"{page.page_number}. Use this image for these full-document fields only: "
                            f"{', '.join(field.key_name for field in field_group)}.",
                        }
                        for page in document.pages
                    ],
                }
            )

    if not field_region_refs:
        return requests

    crop_dir = scratch_dir_for_ref(document.storage_path, "regions", job_id)

    for index, region_ref in enumerate(_group_region_refs(field_region_refs)):
        region = region_ref["region"]
        region_field_names = set(region_ref["field_names"])
        region_fields = [field for field in fields if field.key_name in region_field_names]
        page = page_map.get(region.page)
        if not page:
            raise RuntimeError(f"Region page {region.page} does not exist for fields: {', '.join(region_ref['field_names'])}")
        masked_path = _mask_region_image(page, region, crop_dir / f"region_{index + 1}_masked.png")
        crop_path = _crop_region_image(page, region, crop_dir / f"region_{index + 1}_crop.png")
        for group_index, field_group in enumerate(_chunk_fields(region_fields, field_group_size), start=1):
            field_names = [field.key_name for field in field_group]
            requests.append(
                {
                    "group_id": f"{region_ref['key']}_{group_index}",
                    "fields": field_group,
                    "image_inputs": [
                        {
                            "path": page.image_path,
                            "label": (
                                f"Full page context for extraction region '{region_ref['label']}' on page {region.page}. "
                                "Use this image only to understand the overall document layout and nearby labels; "
                                f"extract values only for these fields: {', '.join(field_names)}."
                            ),
                        },
                        {
                            "path": str(masked_path),
                            "label": (
                                f"Masked full page context for extraction region '{region_ref['label']}' on page {region.page}. "
                                f"Everything outside the region is dimmed. Use this image to understand the region's original page position "
                                f"for these fields only: {', '.join(field_names)}."
                            ),
                        },
                        {
                            "path": str(crop_path),
                            "label": (
                                f"Cropped extraction region '{region_ref['label']}' on page {region.page}. "
                                f"Use this crop as the primary reading source for these fields only: {', '.join(field_names)}."
                            ),
                        },
                    ],
                }
            )

    return requests


def _chunk_fields(fields: list[FieldDefinition], size: int) -> list[list[FieldDefinition]]:
    return [fields[index:index + size] for index in range(0, len(fields), size)]


def _field_region_refs(
    fields: list[FieldDefinition],
    region_map: dict[str, SchemaRegion],
) -> dict[str, dict[str, Any]]:
    refs: dict[str, dict[str, Any]] = {}
    for index, field in enumerate(fields):
        if field.region_id:
            region = region_map.get(field.region_id)
            if not region:
                raise RuntimeError(f"Region {field.region_id} does not exist for field {field.key_name}")
            refs[field.key_name] = {"key": field.region_id, "label": f"{region.name} ({region.id})", "region": region}
        elif field.region:
            refs[field.key_name] = {
                "key": f"legacy_field_{index + 1}",
                "label": f"Legacy region for {field.key_name}",
                "region": field.region,
            }
    return refs


def _group_region_refs(field_region_refs: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for field_name, ref in field_region_refs.items():
        key = ref["key"]
        if key not in grouped:
            grouped[key] = {
                "key": key,
                "label": ref["label"],
                "region": ref["region"],
                "field_names": [],
            }
        grouped[key]["field_names"].append(field_name)
    return list(grouped.values())


def _crop_region_image(page: DocumentPageSnapshot, region: FieldRegion, output_path: Path) -> Path:
    source_path = materialize_storage_ref(page.image_path)
    with Image.open(source_path) as source:
        image = source.convert("RGB")

    width, height = image.size
    box = _region_pixel_box(region, width, height, padding_ratio=0.16)
    crop = image.crop(box)
    if crop.width <= 0 or crop.height <= 0:
        raise RuntimeError("Extraction region is empty")

    scale = max(2.0, min(4.0, 1200 / max(1, crop.width)))
    max_dimension = max(crop.width, crop.height)
    if max_dimension * scale > 2800:
        scale = 2800 / max(1, max_dimension)
    target_size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    if target_size != crop.size:
        crop = crop.resize(target_size, Image.Resampling.LANCZOS)

    crop = ImageEnhance.Contrast(crop).enhance(1.08)
    crop = crop.filter(ImageFilter.SHARPEN)
    crop.save(output_path)
    return output_path


def _mask_region_image(page: DocumentPageSnapshot, region: FieldRegion, output_path: Path) -> Path:
    source_path = materialize_storage_ref(page.image_path)
    with Image.open(source_path) as source:
        image = source.convert("RGB")
    width, height = image.size
    box = _region_pixel_box(region, width, height)

    dimmed = Image.blend(image, Image.new("RGB", image.size, (245, 245, 245)), 0.78)
    dimmed.paste(image.crop(box), box)
    draw = ImageDraw.Draw(dimmed)
    border_width = max(3, min(width, height) // 180)
    for offset in range(border_width):
        draw.rectangle(
            (box[0] - offset, box[1] - offset, box[2] + offset, box[3] + offset),
            outline=(21, 127, 120),
        )
    dimmed.save(output_path)
    return output_path


def _region_pixel_box(
    region: FieldRegion,
    width: int,
    height: int,
    padding_ratio: float = 0.0,
) -> tuple[int, int, int, int]:
    left = max(0, min(width - 1, round(width * region.x)))
    top = max(0, min(height - 1, round(height * region.y)))
    right = max(left + 1, min(width, round(width * (region.x + region.width))))
    bottom = max(top + 1, min(height, round(height * (region.y + region.height))))
    if padding_ratio > 0:
        pad_x = max(4, round((right - left) * padding_ratio))
        pad_y = max(4, round((bottom - top) * padding_ratio))
        left = max(0, left - pad_x)
        top = max(0, top - pad_y)
        right = min(width, right + pad_x)
        bottom = min(height, bottom + pad_y)
    return left, top, right, bottom


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
