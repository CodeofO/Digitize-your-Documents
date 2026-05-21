import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from app.audit import log_audit_event
from app.config import get_settings
from app.database import SessionLocal
from app.models import Document, ExtractionJob, ExtractionResult, Schema
from app.schemas import FieldDefinition, FieldRegion, SchemaRegion
from app.validation import validate_extracted_values
from app.vlm import extract_with_vlm


TERMINAL_JOB_STATUSES = {"completed", "needs_review", "failed", "canceled"}


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
    try:
        context = _prepare_extraction_job(job_id)
        if not context:
            return
        raw_values = _extract_grouped_values(context.document, context.fields, context.regions, job_id)
        _save_extraction_result(job_id, context, raw_values)
    except Exception as exc:
        _mark_job_failed(job_id, str(exc))


def run_batch_jobs(batch_id: str, job_ids: list[str]) -> None:
    if not job_ids:
        _finalize_batch(batch_id)
        return
    max_workers = max(1, min(get_settings().batch_max_workers, len(job_ids)))
    submitted_job_ids: set[str] = set()
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for job_id in job_ids:
                future = executor.submit(run_extraction_job, job_id)
                futures[future] = job_id
                submitted_job_ids.add(job_id)

            for future in as_completed(futures):
                job_id = futures[future]
                try:
                    future.result()
                except Exception as exc:
                    _mark_job_failed(job_id, f"Batch worker failed: {exc}")
    except Exception as exc:
        for job_id in set(job_ids) - submitted_job_ids:
            _mark_job_failed(job_id, f"Batch worker did not start job: {exc}")
        raise
    finally:
        _finalize_batch(batch_id)


def _prepare_extraction_job(job_id: str) -> ExtractionContext | None:
    db = SessionLocal()
    try:
        job = db.get(ExtractionJob, job_id)
        if not job:
            return None
        if job.status == "canceled":
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


def _save_extraction_result(job_id: str, context: ExtractionContext, raw_values: dict[str, Any]) -> None:
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

        values, warnings = validate_extracted_values(raw_values, context.fields)
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
    requests = _build_extraction_requests(document, fields, regions, job_id)
    merged: dict[str, Any] = {}
    for request in requests:
        group_values = extract_with_vlm(request["fields"], image_inputs=request["image_inputs"])
        for key, value in group_values.items():
            merged[key] = value
    return merged


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

    if full_page_fields:
        requests.append(
            {
                "group_id": "full_page",
                "fields": full_page_fields,
                "image_inputs": [
                    {
                        "path": page.image_path,
                        "label": "Full document page "
                        f"{page.page_number}. Use this image for these full-document fields only: "
                        f"{', '.join(field.key_name for field in full_page_fields)}.",
                    }
                    for page in document.pages
                ],
            }
        )

    if not field_region_refs:
        return requests

    crop_dir = Path(document.storage_path).parent / "regions" / job_id
    crop_dir.mkdir(parents=True, exist_ok=True)

    for index, region_ref in enumerate(_group_region_refs(field_region_refs)):
        region = region_ref["region"]
        region_field_names = set(region_ref["field_names"])
        region_fields = [field for field in fields if field.key_name in region_field_names]
        page = page_map.get(region.page)
        if not page:
            raise RuntimeError(f"Region page {region.page} does not exist for fields: {', '.join(region_ref['field_names'])}")
        masked_path = _mask_region_image(page, region, crop_dir / f"region_{index + 1}_masked.png")
        crop_path = _crop_region_image(page, region, crop_dir / f"region_{index + 1}_crop.png")
        requests.append(
            {
                "group_id": region_ref["key"],
                "fields": region_fields,
                "image_inputs": [
                    {
                        "path": page.image_path,
                        "label": (
                            f"Full page context for extraction region '{region_ref['label']}' on page {region.page}. "
                            "Use this image only to understand the overall document layout and nearby labels; "
                            f"extract values only for these fields: {', '.join(region_ref['field_names'])}."
                        ),
                    },
                    {
                        "path": str(masked_path),
                        "label": (
                            f"Masked full page context for extraction region '{region_ref['label']}' on page {region.page}. "
                            f"Everything outside the region is dimmed. Use this image to understand the region's original page position "
                            f"for these fields only: {', '.join(region_ref['field_names'])}."
                        ),
                    },
                    {
                        "path": str(crop_path),
                        "label": (
                            f"Cropped extraction region '{region_ref['label']}' on page {region.page}. "
                            f"Use this crop as the primary reading source for these fields only: {', '.join(region_ref['field_names'])}."
                        ),
                    },
                ],
            }
        )

    return requests


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
    source_path = Path(page.image_path)
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
    source_path = Path(page.image_path)
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
