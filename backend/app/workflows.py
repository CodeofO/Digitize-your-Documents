import csv
import io
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.audit import log_audit_event
from app.config import get_settings
from app.database import SessionLocal
from app.document_modules import classification_result_to_dict, required_field_result_to_dict, run_classification_job, run_required_field_check_job
from app.extraction import result_to_dict, run_extraction_job
from app.models import (
    ClassificationJob,
    DocumentClassifier,
    ExportPreset,
    ExtractionJob,
    RequiredFieldCheckJob,
    RequiredFieldChecklist,
    Schema,
    WorkflowDefinition,
    WorkflowRun,
    WorkflowRunItem,
)


WORKFLOW_NODE_KINDS = {"input", "classifier", "branch", "kie", "required-checker", "merge", "export"}
WORKFLOW_TERMINAL_STATUSES = {"completed", "needs_review", "failed", "canceled"}


class WorkflowPaused(RuntimeError):
    pass


class WorkflowDefinitionError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


@dataclass(frozen=True)
class WorkflowGraph:
    definition: dict[str, Any]
    nodes: dict[str, dict[str, Any]]
    edges: list[dict[str, Any]]
    outgoing: dict[str, list[dict[str, Any]]]
    incoming: dict[str, list[dict[str, Any]]]
    warnings: list[str]


def workflow_definition_to_read(workflow: WorkflowDefinition, db: Session) -> dict[str, Any]:
    definition = _workflow_definition_json(workflow)
    warnings: list[str] = []
    try:
        warnings = validate_workflow_definition(definition, db).warnings
    except WorkflowDefinitionError:
        warnings = []
    return {
        "id": workflow.id,
        "name": workflow.name,
        "description": workflow.description,
        "definition": definition,
        "archived": workflow.archived,
        "validation_warnings": warnings,
        "created_at": workflow.created_at,
        "updated_at": workflow.updated_at,
    }


def _workflow_run_name(run: WorkflowRun) -> str | None:
    return run.workflow_name or (run.workflow.name if run.workflow else None)


def _workflow_definition_for_run(run: WorkflowRun, workflow: WorkflowDefinition | None) -> dict[str, Any]:
    if run.workflow_definition_json:
        try:
            return json.loads(run.workflow_definition_json)
        except json.JSONDecodeError as exc:
            raise ValueError("Workflow run definition snapshot is invalid") from exc
    if not workflow or workflow.archived:
        raise ValueError("Workflow definition not found")
    return _workflow_definition_json(workflow)


def workflow_run_to_read(run: WorkflowRun, *, include_items: bool = True) -> dict[str, Any]:
    items = sorted(run.items, key=_workflow_item_sort_key)
    counters = _workflow_run_counters(run, items)
    completed = [item for item in items if item.status in WORKFLOW_TERMINAL_STATUSES]
    failed = [item for item in items if item.status == "failed"]
    needs_review = [item for item in items if item.status == "needs_review"]
    return {
        "id": run.id,
        "workflow_id": run.workflow_id,
        "workflow_name": _workflow_run_name(run),
        "restarted_from_run_id": run.restarted_from_run_id,
        "status": counters["status"],
        "total_count": run.total_count,
        "completed_count": len(completed),
        "failed_count": len(failed),
        "needs_review_count": len(needs_review),
        "uploaded_count": counters["uploaded_count"],
        "preprocessing_count": counters["preprocessing_count"],
        "ready_count": counters["ready_count"],
        "queued_count": counters["queued_count"],
        "running_count": counters["running_count"],
        "canceled_count": counters["canceled_count"],
        "progress_phase": counters["progress_phase"],
        "progress": counters["progress"],
        "error_message": run.error_message,
        "upload_duration_ms": run.upload_duration_ms,
        "inference_duration_ms": run.inference_duration_ms,
        "items": [workflow_run_item_to_read(item) for item in items] if include_items else [],
        "created_at": run.created_at,
        "completed_at": run.completed_at,
    }


def workflow_run_item_to_read(item: WorkflowRunItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "run_id": item.run_id,
        "document_id": item.document_id,
        "filename": item.filename,
        "upload_index": item.upload_index,
        "status": item.status,
        "error_message": item.error_message,
        "upload_duration_ms": item.upload_duration_ms,
        "inference_duration_ms": item.inference_duration_ms,
        "result": _json_or_empty(item.result_json),
        "created_at": item.created_at,
        "completed_at": item.completed_at,
    }


def validate_workflow_definition(definition: dict[str, Any], db: Session) -> WorkflowGraph:
    graph = _build_graph(definition)
    errors = _validate_graph_shape(graph)
    errors.extend(_validate_config_references(graph, db))
    errors.extend(_validate_branch_shape(graph))
    warnings = _workflow_warnings(graph, db)
    if errors:
        raise WorkflowDefinitionError(errors)
    return WorkflowGraph(
        definition=graph.definition,
        nodes=graph.nodes,
        edges=graph.edges,
        outgoing=graph.outgoing,
        incoming=graph.incoming,
        warnings=warnings,
    )


def run_workflow_run(run_id: str, execution_generation: int | None = None) -> None:
    db = SessionLocal()
    try:
        run = db.get(WorkflowRun, run_id)
        if not run:
            return
        generation = run.execution_generation if execution_generation is None else execution_generation
        if run.execution_generation != generation:
            return
        workflow = db.get(WorkflowDefinition, run.workflow_id)
        try:
            graph = validate_workflow_definition(_workflow_definition_for_run(run, workflow), db)
        except WorkflowDefinitionError as exc:
            _fail_run(db, run, "; ".join(exc.errors))
            return
        except ValueError as exc:
            _fail_run(db, run, str(exc))
            return
        run.status = "running"
        db.commit()
        item_ids = [
            item.id
            for item in sorted(run.items, key=_workflow_item_sort_key)
            if item.status == "queued" and item.execution_generation == generation
        ]
    finally:
        db.close()

    max_workers = max(1, min(get_settings().vlm_max_concurrent_requests, len(item_ids)))
    submitted_item_ids: set[str] = set()
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for item_id in item_ids:
                future = executor.submit(_run_workflow_item, item_id, graph, generation)
                futures[future] = item_id
                submitted_item_ids.add(item_id)
            for future in as_completed(futures):
                item_id = futures[future]
                try:
                    future.result()
                except Exception as exc:
                    _mark_workflow_item_failed(item_id, f"Workflow worker failed: {exc}", execution_generation=generation)
    except Exception as exc:
        for item_id in set(item_ids) - submitted_item_ids:
            _mark_workflow_item_failed(item_id, f"Workflow worker did not start item: {exc}", execution_generation=generation)
        raise

    _finalize_workflow_run(run_id, generation)


def workflow_run_export_payload(run: WorkflowRun) -> dict[str, Any]:
    items = sorted(run.items, key=_workflow_item_sort_key)
    rows = [_workflow_export_row(item) for item in items]
    return {
        "workflow_run_id": run.id,
        "workflow_id": run.workflow_id,
        "workflow_name": _workflow_run_name(run),
        "restarted_from_run_id": run.restarted_from_run_id,
        "status": _workflow_run_status(run, items),
        "total_count": run.total_count,
        "rows": rows,
    }


def workflow_run_export_csv(run: WorkflowRun) -> str:
    rows = workflow_run_export_payload(run)["rows"]
    fieldnames = _workflow_export_fieldnames(rows)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({field: _csv_cell(row.get(field)) for field in fieldnames})
    return output.getvalue()


def _run_workflow_item(item_id: str, graph: WorkflowGraph, execution_generation: int) -> None:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            return
        run = db.get(WorkflowRun, item.run_id)
        if run and run.status == "paused":
            return
        if not run or run.execution_generation != execution_generation or item.execution_generation != execution_generation:
            return
        if item.status != "queued":
            return
        inference_started_at = datetime.utcnow()
        item.status = "running"
        item.error_message = None
        item.result_json = _json_dumps(
            {
                "document_id": item.document_id,
                "filename": item.filename,
                "node_results": {},
                "branch_path": None,
                "path_node_ids": [],
                "completed_node_ids": [],
                "current_node_id": None,
                "current_node_kind": None,
                "current_node_label": None,
            },
        )
        db.commit()

        result = _execute_graph_for_item(db, item, graph)
        db.refresh(item)
        run = db.get(WorkflowRun, item.run_id)
        if not run or run.execution_generation != execution_generation or item.execution_generation != execution_generation:
            db.rollback()
            return
        item.status = result["status"]
        item.error_message = result.get("error_message")
        item.inference_duration_ms = _elapsed_ms(inference_started_at)
        item.result_json = _json_dumps(result)
        item.completed_at = datetime.utcnow()
        log_audit_event(
            db,
            entity_type="workflow_run_item",
            entity_id=item.id,
            action=item.status,
            message=f"Workflow item finished with status {item.status}",
            metadata={"document_id": item.document_id, "workflow_run_id": item.run_id},
        )
        db.commit()
    except WorkflowPaused:
        db.rollback()
    except Exception as exc:
        db.rollback()
        duration = _elapsed_ms(inference_started_at) if "inference_started_at" in locals() else None
        _mark_workflow_item_failed(item_id, str(exc), db=db, inference_duration_ms=duration, execution_generation=execution_generation)
    finally:
        db.close()


def _mark_workflow_item_failed(
    item_id: str,
    message: str,
    db: Session | None = None,
    inference_duration_ms: int | None = None,
    execution_generation: int | None = None,
) -> None:
    owns_session = db is None
    session = db or SessionLocal()
    try:
        failed = session.get(WorkflowRunItem, item_id)
        if not failed:
            return
        if execution_generation is not None:
            run = session.get(WorkflowRun, failed.run_id)
            if not run or run.execution_generation != execution_generation or failed.execution_generation != execution_generation:
                return
        existing = _json_or_empty(failed.result_json)
        failed.status = "failed"
        failed.error_message = message
        if inference_duration_ms is not None:
            failed.inference_duration_ms = inference_duration_ms
        failed.completed_at = datetime.utcnow()
        failed.result_json = _json_dumps(
            {
                "document_id": failed.document_id,
                "filename": failed.filename,
                "node_results": existing.get("node_results", {}),
                "branch_path": existing.get("branch_path"),
                "path_node_ids": existing.get("path_node_ids", []),
                "completed_node_ids": existing.get("completed_node_ids", []),
                "current_node_id": None,
                "current_node_kind": None,
                "current_node_label": None,
                "error_message": message,
            },
        )
        log_audit_event(
            session,
            entity_type="workflow_run_item",
            entity_id=failed.id,
            action="failed",
            message=f"Workflow item failed: {message}",
            metadata={"document_id": failed.document_id, "workflow_run_id": failed.run_id},
        )
        session.commit()
    finally:
        if owns_session:
            session.close()


def _elapsed_ms(started_at: datetime, ended_at: datetime | None = None) -> int:
    ended = ended_at or datetime.utcnow()
    return max(0, int((ended - started_at).total_seconds() * 1000))


def _accumulate_run_inference_duration(run: WorkflowRun, ended_at: datetime) -> None:
    if not run.inference_started_at:
        return
    run.inference_duration_ms = (run.inference_duration_ms or 0) + _elapsed_ms(run.inference_started_at, ended_at)
    run.inference_started_at = None


def _save_workflow_item_progress(
    db: Session,
    item: WorkflowRunItem,
    *,
    node_results: dict[str, Any],
    branch_path: str | None,
    visited: list[str],
    completed_node_ids: list[str],
    current_node_id: str | None = None,
    current_node_kind: str | None = None,
    current_node_label: str | None = None,
) -> None:
    item.result_json = _json_dumps(
        {
            "document_id": item.document_id,
            "filename": item.filename,
            "status": item.status,
            "error_message": item.error_message,
            "branch_path": branch_path,
            "path_node_ids": visited,
            "completed_node_ids": completed_node_ids,
            "current_node_id": current_node_id,
            "current_node_kind": current_node_kind,
            "current_node_label": current_node_label,
            "node_results": node_results,
            **_workflow_summary(node_results, branch_path),
        },
    )
    db.commit()


def _execute_graph_for_item(db: Session, item: WorkflowRunItem, graph: WorkflowGraph) -> dict[str, Any]:
    input_node_id = _single_node_id(graph, "input")
    current_id = _single_next_node_id(graph, input_node_id)
    node_results: dict[str, Any] = {}
    visited: list[str] = []
    completed_node_ids: list[str] = []
    branch_path: str | None = None
    status = "completed"
    error_message: str | None = None

    while current_id:
        _raise_if_workflow_paused(db, item, node_results, branch_path, visited, completed_node_ids, current_id)
        if current_id in visited:
            raise RuntimeError("Workflow cycle detected during execution")
        visited.append(current_id)
        node = graph.nodes[current_id]
        kind = _node_kind(node)
        _save_workflow_item_progress(
            db,
            item,
            node_results=node_results,
            branch_path=branch_path,
            visited=visited,
            completed_node_ids=completed_node_ids,
            current_node_id=current_id,
            current_node_kind=kind,
            current_node_label=_node_label(node),
        )
        if kind == "classifier":
            node_result = _execute_classifier_node(db, item.document_id, node)
            node_results[current_id] = node_result
            _raise_if_workflow_paused(db, item, node_results, branch_path, visited, completed_node_ids, current_id)
            if node_result["status"] == "failed":
                status = "failed"
                error_message = node_result.get("error_message")
                break
            completed_node_ids.append(current_id)
            _save_workflow_item_progress(
                db,
                item,
                node_results=node_results,
                branch_path=branch_path,
                visited=visited,
                completed_node_ids=completed_node_ids,
            )
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "branch":
            branch_edge = _select_branch_edge(graph, current_id, node_results)
            if not branch_edge:
                branch_path = _branch_candidate_key(node_results)
                node_results[current_id] = {
                    "kind": kind,
                    "status": "completed",
                    "branch_key": branch_path,
                    "downstream_skipped": True,
                }
                completed_node_ids.append(current_id)
                break
            branch_path = _branch_edge_key(branch_edge)
            node_results[current_id] = {"kind": kind, "status": "completed", "branch_key": branch_path}
            completed_node_ids.append(current_id)
            _save_workflow_item_progress(
                db,
                item,
                node_results=node_results,
                branch_path=branch_path,
                visited=visited,
                completed_node_ids=completed_node_ids,
            )
            current_id = branch_edge["target"]
            continue
        if kind == "kie":
            node_result = _execute_kie_node(db, item.document_id, node)
            node_results[current_id] = node_result
            _raise_if_workflow_paused(db, item, node_results, branch_path, visited, completed_node_ids, current_id)
            if node_result["status"] == "failed":
                status = "failed"
                error_message = node_result.get("error_message")
                break
            if node_result["status"] == "needs_review":
                status = "needs_review"
            completed_node_ids.append(current_id)
            _save_workflow_item_progress(
                db,
                item,
                node_results=node_results,
                branch_path=branch_path,
                visited=visited,
                completed_node_ids=completed_node_ids,
            )
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "required-checker":
            node_result = _execute_required_node(db, item.document_id, node)
            node_results[current_id] = node_result
            _raise_if_workflow_paused(db, item, node_results, branch_path, visited, completed_node_ids, current_id)
            if node_result["status"] == "failed":
                status = "failed"
                error_message = node_result.get("error_message")
                break
            overall = node_result.get("required_check", {}).get("overall_status")
            if node_result["status"] == "needs_review" or overall in {"incomplete", "needs_review"}:
                status = "needs_review"
            completed_node_ids.append(current_id)
            _save_workflow_item_progress(
                db,
                item,
                node_results=node_results,
                branch_path=branch_path,
                visited=visited,
                completed_node_ids=completed_node_ids,
            )
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "merge":
            node_results[current_id] = {"kind": kind, "status": "completed"}
            completed_node_ids.append(current_id)
            _save_workflow_item_progress(
                db,
                item,
                node_results=node_results,
                branch_path=branch_path,
                visited=visited,
                completed_node_ids=completed_node_ids,
            )
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "export":
            node_results[current_id] = {"kind": kind, "status": "completed"}
            completed_node_ids.append(current_id)
            break
        current_id = _single_next_node_id(graph, current_id)

    summary = _workflow_summary(node_results, branch_path)
    return {
        "document_id": item.document_id,
        "filename": item.filename,
        "status": status,
        "error_message": error_message,
        "branch_path": branch_path,
        "path_node_ids": visited,
        "completed_node_ids": completed_node_ids,
        "current_node_id": None,
        "current_node_kind": None,
        "current_node_label": None,
        "node_results": node_results,
        **summary,
    }


def _raise_if_workflow_paused(
    db: Session,
    item: WorkflowRunItem,
    node_results: dict[str, Any],
    branch_path: str | None,
    visited: list[str],
    completed_node_ids: list[str],
    current_node_id: str | None,
) -> None:
    run = db.get(WorkflowRun, item.run_id)
    if run and run.status == "paused":
        item.status = "paused"
        item.error_message = "Paused by user"
        _save_workflow_item_progress(
            db,
            item,
            node_results=node_results,
            branch_path=branch_path,
            visited=visited,
            completed_node_ids=completed_node_ids,
            current_node_id=current_node_id,
            current_node_kind=None,
            current_node_label=None,
        )
        raise WorkflowPaused()


def _execute_classifier_node(db: Session, document_id: str, node: dict[str, Any]) -> dict[str, Any]:
    classifier_id = _node_config_value(node, "classifier_id")
    job = ClassificationJob(document_id=document_id, classifier_id=classifier_id, status="queued")
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="classification_job",
        entity_id=job.id,
        action="queued",
        message="Queued workflow classification job",
        metadata={"document_id": document_id, "classifier_id": classifier_id},
    )
    db.commit()
    run_classification_job(job.id)
    db.expire_all()
    loaded = db.get(ClassificationJob, job.id)
    if not loaded:
        return {"kind": "classifier", "status": "failed", "job_id": job.id, "error_message": "Classification job disappeared"}
    if loaded.status == "failed":
        return {
            "kind": "classifier",
            "status": "failed",
            "job_id": loaded.id,
            "result_id": loaded.result_id,
            "error_message": loaded.error_message,
        }
    output = classification_result_to_dict(loaded.result) if loaded.result else None
    classification = output["corrected_output"] if output and output.get("corrected_output") else output.get("validated_output") if output else {}
    return {
        "kind": "classifier",
        "status": loaded.status,
        "job_id": loaded.id,
        "result_id": loaded.result_id,
        "classifier_id": classifier_id,
        "classification": classification,
        "result": output,
    }


def _execute_kie_node(db: Session, document_id: str, node: dict[str, Any]) -> dict[str, Any]:
    schema_id = _node_config_value(node, "schema_id")
    job = ExtractionJob(document_id=document_id, schema_id=schema_id, schema_version=1, status="queued")
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="extraction_job",
        entity_id=job.id,
        action="queued",
        message="Queued workflow KIE job",
        metadata={"document_id": document_id, "schema_id": schema_id},
    )
    db.commit()
    run_extraction_job(job.id)
    db.expire_all()
    loaded = db.get(ExtractionJob, job.id)
    if not loaded:
        return {"kind": "kie", "status": "failed", "job_id": job.id, "error_message": "Extraction job disappeared"}
    if loaded.status == "failed":
        return {
            "kind": "kie",
            "status": "failed",
            "job_id": loaded.id,
            "result_id": loaded.result_id,
            "error_message": loaded.error_message,
        }
    output = result_to_dict(loaded.result) if loaded.result else None
    payload = output["corrected_output"] if output and output.get("corrected_output") else output.get("validated_output") if output else {}
    return {
        "kind": "kie",
        "status": loaded.status,
        "job_id": loaded.id,
        "result_id": loaded.result_id,
        "schema_id": schema_id,
        "values": payload.get("values", {}),
        "result": output,
    }


def _execute_required_node(db: Session, document_id: str, node: dict[str, Any]) -> dict[str, Any]:
    checklist_id = _node_config_value(node, "checklist_id")
    job = RequiredFieldCheckJob(document_id=document_id, checklist_id=checklist_id, status="queued")
    db.add(job)
    db.flush()
    log_audit_event(
        db,
        entity_type="required_field_check_job",
        entity_id=job.id,
        action="queued",
        message="Queued workflow required field check job",
        metadata={"document_id": document_id, "checklist_id": checklist_id},
    )
    db.commit()
    run_required_field_check_job(job.id)
    db.expire_all()
    loaded = db.get(RequiredFieldCheckJob, job.id)
    if not loaded:
        return {"kind": "required-checker", "status": "failed", "job_id": job.id, "error_message": "Required check job disappeared"}
    if loaded.status == "failed":
        return {
            "kind": "required-checker",
            "status": "failed",
            "job_id": loaded.id,
            "result_id": loaded.result_id,
            "error_message": loaded.error_message,
        }
    output = required_field_result_to_dict(loaded.result) if loaded.result else None
    payload = output["corrected_output"] if output and output.get("corrected_output") else output.get("validated_output") if output else {}
    return {
        "kind": "required-checker",
        "status": loaded.status,
        "job_id": loaded.id,
        "result_id": loaded.result_id,
        "checklist_id": checklist_id,
        "required_check": payload,
        "result": output,
    }


def _finalize_workflow_run(run_id: str, execution_generation: int | None = None) -> None:
    db = SessionLocal()
    try:
        run = db.get(WorkflowRun, run_id)
        if not run:
            return
        if execution_generation is not None and run.execution_generation != execution_generation:
            return
        now = datetime.utcnow()
        statuses = [item.status for item in run.items]
        if not statuses:
            run.status = "failed"
            run.error_message = "Workflow run has no items"
        elif run.status == "paused" or any(status == "paused" for status in statuses):
            run.status = "paused"
            run.completed_at = None
            _accumulate_run_inference_duration(run, now)
            db.commit()
            return
        elif any(status in {"queued", "running", "preprocessing"} for status in statuses):
            run.status = "running"
            run.completed_at = None
            db.commit()
            return
        elif any(status == "failed" for status in statuses):
            run.status = "completed_with_errors"
        elif any(status == "needs_review" for status in statuses):
            run.status = "needs_review"
        elif all(status == "canceled" for status in statuses):
            run.status = "canceled"
        else:
            run.status = "completed"
        run.completed_at = now
        _accumulate_run_inference_duration(run, now)
        log_audit_event(
            db,
            entity_type="workflow_run",
            entity_id=run.id,
            action=run.status,
            message=f"Workflow run finished with status {run.status}",
            metadata={"total_count": run.total_count},
        )
        db.commit()
    finally:
        db.close()


def _fail_run(db: Session, run: WorkflowRun, message: str) -> None:
    now = datetime.utcnow()
    run.status = "failed"
    run.error_message = message
    run.completed_at = now
    _accumulate_run_inference_duration(run, now)
    for item in run.items:
        item.status = "failed"
        item.error_message = message
        item.completed_at = now
    db.commit()


def _workflow_definition_json(workflow: WorkflowDefinition) -> dict[str, Any]:
    return _json_or_empty(workflow.definition_json)


def _json_or_empty(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


def _build_graph(definition: dict[str, Any]) -> WorkflowGraph:
    nodes_raw = definition.get("nodes") if isinstance(definition.get("nodes"), list) else []
    edges_raw = definition.get("edges") if isinstance(definition.get("edges"), list) else []
    nodes = {str(node.get("id")): node for node in nodes_raw if isinstance(node, dict) and node.get("id")}
    edges = [
        {"id": str(edge.get("id") or f"{edge.get('source')}->{edge.get('target')}"), **edge}
        for edge in edges_raw
        if isinstance(edge, dict) and edge.get("source") and edge.get("target")
    ]
    outgoing: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in nodes}
    incoming: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in nodes}
    for edge in edges:
        source = str(edge["source"])
        target = str(edge["target"])
        outgoing.setdefault(source, []).append(edge)
        incoming.setdefault(target, []).append(edge)
    return WorkflowGraph(definition=definition, nodes=nodes, edges=edges, outgoing=outgoing, incoming=incoming, warnings=[])


def _validate_graph_shape(graph: WorkflowGraph) -> list[str]:
    errors: list[str] = []
    if not graph.nodes:
        return ["Workflow must include at least one node"]
    invalid = [node_id for node_id, node in graph.nodes.items() if _node_kind(node) not in WORKFLOW_NODE_KINDS]
    if invalid:
        errors.append(f"Unsupported workflow node kind: {', '.join(invalid)}")
    input_nodes = [node_id for node_id, node in graph.nodes.items() if _node_kind(node) == "input"]
    export_nodes = [node_id for node_id, node in graph.nodes.items() if _node_kind(node) == "export"]
    if len(input_nodes) != 1:
        errors.append("Workflow must have exactly one Input node")
    if not export_nodes:
        errors.append("Workflow must include an Export node")
    for edge in graph.edges:
        if edge["source"] not in graph.nodes or edge["target"] not in graph.nodes:
            errors.append(f"Edge {edge['id']} references a missing node")
    if _has_cycle(graph):
        errors.append("Workflow graph cannot contain a cycle")
    for node_id, node in graph.nodes.items():
        kind = _node_kind(node)
        if kind not in {"branch", "export"} and len(graph.outgoing.get(node_id, [])) > 1:
            errors.append(f"Node {node_id} can only have one outgoing edge in v1")
        if kind == "export" and graph.outgoing.get(node_id):
            errors.append(f"Export node {node_id} cannot have outgoing edges")
    return errors


def _validate_config_references(graph: WorkflowGraph, db: Session) -> list[str]:
    errors: list[str] = []
    input_nodes = [node_id for node_id, node in graph.nodes.items() if _node_kind(node) == "input"]
    active_node_ids = _reachable_node_ids(graph, input_nodes[0]) if input_nodes else set(graph.nodes)
    for node_id, node in graph.nodes.items():
        if node_id not in active_node_ids:
            continue
        kind = _node_kind(node)
        if kind == "classifier":
            classifier_id = _node_config_value(node, "classifier_id")
            classifier = db.get(DocumentClassifier, classifier_id) if classifier_id else None
            if not classifier or classifier.archived:
                errors.append(f"Classifier node {node_id} must select a saved classifier")
        if kind == "kie":
            schema_id = _node_config_value(node, "schema_id")
            schema = db.get(Schema, schema_id) if schema_id else None
            if not schema or schema.archived or schema.ephemeral:
                errors.append(f"KIE node {node_id} must select a saved schema")
        if kind == "required-checker":
            checklist_id = _node_config_value(node, "checklist_id")
            checklist = db.get(RequiredFieldChecklist, checklist_id) if checklist_id else None
            if not checklist or checklist.archived:
                errors.append(f"Required Field Checker node {node_id} must select a saved checklist")
    return errors


def _validate_branch_shape(graph: WorkflowGraph) -> list[str]:
    errors: list[str] = []
    for node_id, node in graph.nodes.items():
        if _node_kind(node) != "branch":
            continue
        incoming = graph.incoming.get(node_id, [])
        if len(incoming) != 1:
            errors.append(f"Branch node {node_id} must have one incoming classifier edge")
            continue
        source_node = graph.nodes.get(incoming[0]["source"])
        if not source_node or _node_kind(source_node) != "classifier":
            errors.append(f"Branch node {node_id} must be connected directly after a classifier")
    return errors


def _workflow_warnings(graph: WorkflowGraph, db: Session) -> list[str]:
    warnings: list[str] = []
    input_nodes = [node_id for node_id, node in graph.nodes.items() if _node_kind(node) == "input"]
    if input_nodes:
        disconnected = sorted(set(graph.nodes) - _reachable_node_ids(graph, input_nodes[0]))
        if disconnected:
            warnings.append(f"Workflow has disconnected node(s): {', '.join(disconnected)}")
    for node_id, node in graph.nodes.items():
        if _node_kind(node) != "branch":
            continue
        edge_keys = {_branch_edge_key(edge) for edge in graph.outgoing.get(node_id, [])}
        if not edge_keys:
            warnings.append(f"Branch node {node_id} has no outgoing branch path; documents stop after classification")
        if "unknown" not in edge_keys:
            warnings.append(f"Branch node {node_id} has no unknown fallback")
        incoming = graph.incoming.get(node_id, [])
        if not incoming:
            continue
        classifier_node = graph.nodes.get(incoming[0]["source"])
        classifier_id = _node_config_value(classifier_node or {}, "classifier_id")
        classifier = db.get(DocumentClassifier, classifier_id) if classifier_id else None
        if not classifier:
            continue
        config = _json_or_empty(classifier.config_json)
        for candidate in config.get("classes", []):
            class_name = candidate.get("class_name") if isinstance(candidate, dict) else None
            if class_name and f"class:{class_name}" not in edge_keys:
                warnings.append(f"Branch node {node_id} has no path for class {class_name}")
    return warnings


def _reachable_node_ids(graph: WorkflowGraph, start_id: str) -> set[str]:
    visited: set[str] = set()
    stack = [start_id]
    while stack:
        node_id = stack.pop()
        if node_id in visited:
            continue
        visited.add(node_id)
        stack.extend(str(edge["target"]) for edge in graph.outgoing.get(node_id, []))
    return visited


def _has_cycle(graph: WorkflowGraph) -> bool:
    visited: set[str] = set()
    active: set[str] = set()

    def visit(node_id: str) -> bool:
        if node_id in active:
            return True
        if node_id in visited:
            return False
        active.add(node_id)
        for edge in graph.outgoing.get(node_id, []):
            if visit(str(edge["target"])):
                return True
        active.remove(node_id)
        visited.add(node_id)
        return False

    return any(visit(node_id) for node_id in graph.nodes)


def _node_kind(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    kind = node.get("kind") or data.get("kind") or node.get("type") or ""
    aliases = {
        "document-classifier": "classifier",
        "classification": "classifier",
        "key-info": "kie",
        "required": "required-checker",
        "required_field_checker": "required-checker",
    }
    return aliases.get(str(kind), str(kind))


def _node_label(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    label = data.get("label") or node.get("label") or _node_kind(node)
    return str(label)


def _node_config_value(node: dict[str, Any], key: str) -> str | None:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    value = config.get(key) or data.get(key) or node.get(key)
    return str(value).strip() if value else None


def _single_node_id(graph: WorkflowGraph, kind: str) -> str:
    matches = [node_id for node_id, node in graph.nodes.items() if _node_kind(node) == kind]
    if len(matches) != 1:
        raise RuntimeError(f"Workflow must have exactly one {kind} node")
    return matches[0]


def _single_next_node_id(graph: WorkflowGraph, node_id: str) -> str | None:
    outgoing = graph.outgoing.get(node_id, [])
    if not outgoing:
        return None
    if len(outgoing) > 1:
        raise RuntimeError(f"Node {node_id} has multiple outgoing edges")
    return str(outgoing[0]["target"])


def _select_branch_edge(graph: WorkflowGraph, branch_node_id: str, node_results: dict[str, Any]) -> dict[str, Any] | None:
    candidates = _branch_candidate_keys(node_results)
    by_key = {_branch_edge_key(edge): edge for edge in graph.outgoing.get(branch_node_id, [])}
    for key in candidates:
        if key in by_key:
            return by_key[key]
    return None


def _branch_candidate_key(node_results: dict[str, Any]) -> str:
    return _branch_candidate_keys(node_results)[0]


def _branch_candidate_keys(node_results: dict[str, Any]) -> list[str]:
    classification = _latest_classification(node_results)
    status = classification.get("status")
    class_name = classification.get("class_name")
    candidates: list[str] = []
    if status == "classified" and class_name:
        candidates.append(f"class:{class_name}")
    else:
        candidates.append("unknown")
    return candidates


def _branch_edge_key(edge: dict[str, Any]) -> str:
    data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
    raw = data.get("branchKey") or data.get("branch_key") or edge.get("sourceHandle") or edge.get("branch_key") or "default"
    key = str(raw).strip()
    if key.startswith("class-"):
        return f"class:{key.removeprefix('class-')}"
    if key.startswith("class:"):
        return key
    if key in {"unknown", "needs_review", "default"}:
        return key
    return f"class:{key}" if key else "default"


def _latest_classification(node_results: dict[str, Any]) -> dict[str, Any]:
    for result in reversed(list(node_results.values())):
        classification = result.get("classification") if isinstance(result, dict) else None
        if isinstance(classification, dict):
            return classification
    return {}


def _workflow_summary(node_results: dict[str, Any], branch_path: str | None) -> dict[str, Any]:
    classification = _latest_classification(node_results)
    kie_values: dict[str, Any] = {}
    required_items: dict[str, Any] = {}
    required_overall: str | None = None
    for result in node_results.values():
        if not isinstance(result, dict):
            continue
        if result.get("kind") == "kie" and isinstance(result.get("values"), dict):
            for key, value in result["values"].items():
                kie_values[key] = value
        if result.get("kind") == "required-checker" and isinstance(result.get("required_check"), dict):
            required_overall = result["required_check"].get("overall_status")
            for item in result["required_check"].get("items", []):
                if isinstance(item, dict) and item.get("item_name"):
                    required_items[item["item_name"]] = item
    return {
        "classification": classification,
        "branch_path": branch_path,
        "kie_values": kie_values,
        "required_overall_status": required_overall,
        "required_items": required_items,
    }


def _workflow_run_status(run: WorkflowRun, items: list[WorkflowRunItem]) -> str:
    if run.status in WORKFLOW_TERMINAL_STATUSES or run.status in {"completed_with_errors", "failed"}:
        return run.status
    if run.status == "paused":
        return "paused"
    statuses = [item.status for item in items]
    if len(statuses) < run.total_count:
        return "uploading"
    if not statuses:
        return run.status
    if any(status == "preprocessing" for status in statuses):
        return "preprocessing"
    if any(status == "running" for status in statuses):
        return "running"
    if any(status == "paused" for status in statuses):
        return "paused"
    if run.status == "running" and any(status == "queued" for status in statuses):
        return "running"
    if any(status == "queued" for status in statuses):
        return "queued"
    if any(status == "failed" for status in statuses):
        return "completed_with_errors"
    if any(status == "needs_review" for status in statuses):
        return "needs_review"
    return "completed"


def _workflow_item_sort_key(item: WorkflowRunItem) -> tuple[int, int, str, str]:
    if item.upload_index is None:
        return (1, 0, item.filename.casefold(), item.id)
    return (0, item.upload_index, item.filename.casefold(), item.id)


def _workflow_run_counters(run: WorkflowRun, items: list[WorkflowRunItem]) -> dict[str, Any]:
    statuses = [item.status for item in items]
    terminal_count = sum(1 for status in statuses if status in WORKFLOW_TERMINAL_STATUSES)
    preprocessing_count = sum(1 for status in statuses if status == "preprocessing")
    queued_count = sum(1 for status in statuses if status == "queued")
    running_count = sum(1 for status in statuses if status == "running")
    canceled_count = sum(1 for status in statuses if status == "canceled")
    paused_count = sum(1 for status in statuses if status == "paused")
    status = _workflow_run_status(run, items)
    if status == "paused" or paused_count:
        progress_phase = "paused"
    elif len(statuses) < run.total_count:
        progress_phase = "uploading"
    elif preprocessing_count:
        progress_phase = "preprocessing"
    elif running_count or (run.status == "running" and queued_count):
        progress_phase = "running"
    else:
        progress_phase = status
    return {
        "status": status,
        "uploaded_count": len(statuses),
        "preprocessing_count": preprocessing_count,
        "ready_count": max(0, len(statuses) - preprocessing_count),
        "queued_count": queued_count,
        "running_count": running_count,
        "canceled_count": canceled_count,
        "progress_phase": progress_phase,
        "progress": terminal_count / run.total_count if run.total_count else 0,
    }


def _extract_kie_cell_value(value: Any) -> Any:
    return value.get("value") if isinstance(value, dict) else value


def _values_payload(output: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(output, dict):
        return {}
    corrected = output.get("corrected_output")
    if isinstance(corrected, dict):
        return corrected
    validated = output.get("validated_output")
    return validated if isinstance(validated, dict) else {}


def _validated_values_payload(output: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(output, dict):
        return {}
    validated = output.get("validated_output")
    return validated if isinstance(validated, dict) else {}


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


def _workflow_export_row(item: WorkflowRunItem) -> dict[str, Any]:
    result = _json_or_empty(item.result_json)
    classification = result.get("classification") if isinstance(result.get("classification"), dict) else {}
    row: dict[str, Any] = {
        "filename": item.filename,
        "document_id": item.document_id,
        "workflow_run_item_id": item.id,
        "status": item.status,
        "error_message": item.error_message or result.get("error_message"),
        "upload_duration_ms": item.upload_duration_ms,
        "inference_duration_ms": item.inference_duration_ms,
        "classification_status": classification.get("status"),
        "class_name": classification.get("class_name"),
        "branch_path": result.get("branch_path"),
    }
    kie_values = result.get("kie_values") if isinstance(result.get("kie_values"), dict) else {}
    for key, value in kie_values.items():
        _add_kie_review_export_columns(row, f"kie_{key}", value, field_name=key)
    node_results = result.get("node_results") if isinstance(result.get("node_results"), dict) else {}
    for node_result in node_results.values():
        if not isinstance(node_result, dict) or node_result.get("kind") != "kie":
            continue
        output = node_result.get("result") if isinstance(node_result.get("result"), dict) else {}
        values = _values_payload(output).get("values", {})
        original_values = _validated_values_payload(output).get("values", {})
        reviewed_fields = set(output.get("reviewed_fields", [])) if isinstance(output.get("reviewed_fields"), list) else set()
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            _add_kie_review_export_columns(
                row,
                f"kie_{key}",
                value,
                original_values.get(key) if isinstance(original_values, dict) else None,
                reviewed_fields,
                key,
            )
    row["required_overall_status"] = result.get("required_overall_status")
    required_items = result.get("required_items") if isinstance(result.get("required_items"), dict) else {}
    for item_name, entry in required_items.items():
        if isinstance(entry, dict):
            row[f"required_{item_name}_status"] = entry.get("status")
            row[f"required_{item_name}_evidence"] = entry.get("evidence")
    return row


def _workflow_export_fieldnames(rows: list[dict[str, Any]]) -> list[str]:
    base = [
        "filename",
        "document_id",
        "workflow_run_item_id",
        "status",
        "error_message",
        "upload_duration_ms",
        "inference_duration_ms",
        "classification_status",
        "class_name",
        "branch_path",
        "required_overall_status",
    ]
    extras: list[str] = []
    for row in rows:
        for key in row:
            if key not in base and key not in extras:
                extras.append(key)
    return base + sorted(extras)


def _csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, list):
        return ";".join(str(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return value
