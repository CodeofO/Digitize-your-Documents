import asyncio
import csv
import io
import json
import threading
from collections import Counter
from datetime import datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit import log_audit_event
from app.concurrency import gather_workflow_limited, run_workflow_blocking
from app.database import SessionLocal
from app.document_modules import (
    classification_result_to_dict,
    required_field_result_to_dict,
    run_classification_job,
    run_classification_job_async,
    run_required_field_check_job,
    run_required_field_check_job_async,
)
from app.extraction import result_to_dict, run_extraction_job, run_extraction_job_async
from app.models import (
    ClassificationJob,
    Document,
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
from app.vlm import vlm_runtime_counters
from app.workflow_graph import (
    WorkflowGraph,
    branch_candidate_key as _branch_candidate_key,
    branch_edge_key as _branch_edge_key,
    build_workflow_graph as _build_graph,
    node_config_value as _node_config_value,
    node_kind as _node_kind,
    node_label as _node_label,
    reachable_node_ids as _reachable_node_ids,
    select_branch_edge as _select_branch_edge,
    single_next_node_id as _single_next_node_id,
    single_node_id as _single_node_id,
    validate_workflow_branch_shape as _validate_branch_shape,
    validate_workflow_graph_shape as _validate_graph_shape,
    workflow_summary as _workflow_summary,
)


WORKFLOW_TERMINAL_STATUSES = {"completed", "needs_review", "failed", "canceled"}
WORKFLOW_QUEUE_ADVANCE_STATUSES = {"completed", "completed_with_errors", "needs_review"}


class WorkflowPaused(RuntimeError):
    pass


class WorkflowStopped(RuntimeError):
    pass


class WorkflowDefinitionError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


def workflow_definition_to_read(workflow: WorkflowDefinition, db: Session) -> dict[str, Any]:
    definition = _workflow_definition_json(workflow)
    warnings: list[str] = []
    try:
        warnings = validate_workflow_definition(definition, db, workspace_id=workflow.workspace_id).warnings
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


def workflow_runs_to_read(
    runs: list[WorkflowRun],
    *,
    include_items: bool = True,
    db: Session | None = None,
) -> list[dict[str, Any]]:
    if include_items or db is None:
        return [workflow_run_to_read(run, include_items=include_items, db=db) for run in runs]

    status_counts_by_run = _workflow_run_status_counts_for_runs([run.id for run in runs], db)
    return [
        _workflow_run_to_read_with_status_counts(run, status_counts_by_run.get(run.id, {}), include_items=False)
        for run in runs
    ]


def workflow_run_to_read(
    run: WorkflowRun,
    *,
    include_items: bool = True,
    db: Session | None = None,
) -> dict[str, Any]:
    if include_items:
        items = sorted(run.items, key=_workflow_item_sort_key)
        status_counts = _workflow_item_status_counts(items)
        return _workflow_run_to_read_with_status_counts(run, status_counts, items=items, include_items=True)

    if db is not None:
        return _workflow_run_to_read_with_status_counts(run, _workflow_run_status_counts_from_db(run.id, db), include_items=False)

    items = sorted(run.items, key=_workflow_item_sort_key)
    return _workflow_run_to_read_with_status_counts(run, _workflow_item_status_counts(items), items=items, include_items=False)


def _workflow_run_to_read_with_status_counts(
    run: WorkflowRun,
    status_counts: dict[str, int],
    *,
    items: list[WorkflowRunItem] | None = None,
    include_items: bool,
) -> dict[str, Any]:
    items = items or []
    counters = _workflow_run_counters_from_status_counts(run, status_counts)
    vlm_counters = vlm_runtime_counters()
    return {
        "id": run.id,
        "workflow_id": run.workflow_id,
        "workflow_name": _workflow_run_name(run),
        "restarted_from_run_id": run.restarted_from_run_id,
        "workflow_run_group_id": run.workflow_run_group_id,
        "queued_from_run_id": run.queued_from_run_id,
        "queue_order": run.queue_order,
        "status": counters["status"],
        "total_count": run.total_count,
        "completed_count": counters["completed_count"],
        "failed_count": status_counts.get("failed", 0),
        "needs_review_count": status_counts.get("needs_review", 0),
        "uploaded_count": counters["uploaded_count"],
        "preprocessing_count": counters["preprocessing_count"],
        "ready_count": counters["ready_count"],
        "queued_count": counters["queued_count"],
        "running_count": counters["running_count"],
        "canceled_count": counters["canceled_count"],
        "vlm_active_count": vlm_counters["vlm_active_count"],
        "vlm_waiting_count": vlm_counters["vlm_waiting_count"],
        "vlm_limit": vlm_counters["vlm_limit"],
        "progress_phase": counters["progress_phase"],
        "progress": counters["progress"],
        "error_message": run.error_message,
        "upload_duration_ms": run.upload_duration_ms,
        "inference_duration_ms": run.inference_duration_ms,
        "items": [workflow_run_item_to_read(item) for item in items] if include_items else [],
        "created_at": run.created_at,
        "started_at": run.started_at,
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


def validate_workflow_definition(definition: dict[str, Any], db: Session, *, workspace_id: str | None = None) -> WorkflowGraph:
    graph = _build_graph(definition)
    errors = _validate_graph_shape(graph)
    errors.extend(_validate_config_references(graph, db, workspace_id=workspace_id))
    errors.extend(_validate_branch_shape(graph))
    warnings = _workflow_warnings(graph, db, workspace_id=workspace_id)
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
    asyncio.run(run_workflow_run_async(run_id, execution_generation))


async def run_workflow_run_async(run_id: str, execution_generation: int | None = None) -> None:
    prepared = await run_workflow_blocking(_prepare_workflow_run_execution, run_id, execution_generation)
    if not prepared:
        return
    graph, item_ids, generation = prepared
    results = await gather_workflow_limited(
        item_ids,
        lambda item_id: _run_workflow_item_async(item_id, graph, generation),
        return_exceptions=True,
    )
    for item_id, result in zip(item_ids, results, strict=True):
        if isinstance(result, Exception):
            await run_workflow_blocking(
                _mark_workflow_item_failed,
                item_id,
                f"Workflow worker failed: {result}",
                execution_generation=generation,
            )
    await run_workflow_blocking(_finalize_workflow_run, run_id, generation)


def _prepare_workflow_run_execution(
    run_id: str,
    execution_generation: int | None = None,
) -> tuple[WorkflowGraph, list[str], int] | None:
    db = SessionLocal()
    try:
        run = db.get(WorkflowRun, run_id)
        if not run:
            return
        if run.status == "waiting":
            return
        generation = run.execution_generation if execution_generation is None else execution_generation
        if run.execution_generation != generation:
            return
        workflow = db.get(WorkflowDefinition, run.workflow_id)
        try:
            graph = validate_workflow_definition(_workflow_definition_for_run(run, workflow), db, workspace_id=run.workspace_id)
        except WorkflowDefinitionError as exc:
            _fail_run(db, run, "; ".join(exc.errors))
            return
        except ValueError as exc:
            _fail_run(db, run, str(exc))
            return
        run.status = "running"
        run.started_at = run.started_at or datetime.utcnow()
        db.commit()
        item_ids = [
            item.id
            for item in sorted(run.items, key=_workflow_item_sort_key)
            if item.status == "queued" and item.execution_generation == generation
        ]
        return graph, item_ids, generation
    finally:
        db.close()


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


async def _run_workflow_item_async(item_id: str, graph: WorkflowGraph, execution_generation: int) -> None:
    inference_started_at: datetime | None = None
    try:
        started = await run_workflow_blocking(_begin_workflow_item, item_id, execution_generation)
        if not started:
            return
        inference_started_at = started["inference_started_at"]
        result = await _execute_graph_for_item_async(item_id, started["document_id"], started["filename"], graph, execution_generation)
        await run_workflow_blocking(_finish_workflow_item, item_id, execution_generation, inference_started_at, result)
    except (WorkflowPaused, WorkflowStopped):
        return
    except Exception as exc:
        duration = _elapsed_ms(inference_started_at) if inference_started_at else None
        await run_workflow_blocking(
            _mark_workflow_item_failed,
            item_id,
            str(exc),
            inference_duration_ms=duration,
            execution_generation=execution_generation,
        )


def _begin_workflow_item(item_id: str, execution_generation: int) -> dict[str, Any] | None:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            return None
        run = db.get(WorkflowRun, item.run_id)
        if run and run.status == "paused":
            return None
        if not run or run.execution_generation != execution_generation or item.execution_generation != execution_generation:
            return None
        if item.status != "queued":
            return None
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
        return {
            "document_id": item.document_id,
            "filename": item.filename,
            "inference_started_at": inference_started_at,
        }
    finally:
        db.close()


def _finish_workflow_item(
    item_id: str,
    execution_generation: int,
    inference_started_at: datetime,
    result: dict[str, Any],
) -> None:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            return
        run = db.get(WorkflowRun, item.run_id)
        if not run or run.execution_generation != execution_generation or item.execution_generation != execution_generation:
            db.rollback()
            return
        if run.status == "paused" or item.status == "paused":
            raise WorkflowPaused()
        if run.status == "canceled" or item.status == "canceled":
            raise WorkflowStopped()
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
    finally:
        db.close()


def _save_workflow_item_progress_by_id(
    item_id: str,
    execution_generation: int,
    *,
    node_results: dict[str, Any],
    branch_path: str | None,
    visited: list[str],
    completed_node_ids: list[str],
    current_node_id: str | None = None,
    current_node_kind: str | None = None,
    current_node_label: str | None = None,
) -> None:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            return
        run = db.get(WorkflowRun, item.run_id)
        if not run or run.execution_generation != execution_generation or item.execution_generation != execution_generation:
            return
        _save_workflow_item_progress(
            db,
            item,
            node_results=node_results,
            branch_path=branch_path,
            visited=visited,
            completed_node_ids=completed_node_ids,
            current_node_id=current_node_id,
            current_node_kind=current_node_kind,
            current_node_label=current_node_label,
        )
    finally:
        db.close()


def _ensure_workflow_item_active(
    item_id: str,
    execution_generation: int,
    *,
    node_results: dict[str, Any],
    branch_path: str | None,
    visited: list[str],
    completed_node_ids: list[str],
    current_node_id: str | None,
) -> None:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            raise WorkflowStopped()
        run = db.get(WorkflowRun, item.run_id)
        if not run or run.execution_generation != execution_generation or item.execution_generation != execution_generation:
            raise WorkflowStopped()
        if run.status == "canceled" or item.status == "canceled":
            raise WorkflowStopped()
        if run.status == "paused" or item.status == "paused":
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


_ORIGINAL_EXECUTE_GRAPH_FOR_ITEM = _execute_graph_for_item


def _execute_graph_for_item_compat(item_id: str, graph: WorkflowGraph) -> dict[str, Any]:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            raise WorkflowStopped()
        return _execute_graph_for_item(db, item, graph)
    finally:
        db.close()


async def _execute_graph_for_item_async(
    item_id: str,
    document_id: str,
    filename: str,
    graph: WorkflowGraph,
    execution_generation: int,
) -> dict[str, Any]:
    if _execute_graph_for_item is not _ORIGINAL_EXECUTE_GRAPH_FOR_ITEM:
        return await run_workflow_blocking(_execute_graph_for_item_compat, item_id, graph)

    input_node_id = _single_node_id(graph, "input")
    current_id = _single_next_node_id(graph, input_node_id)
    node_results: dict[str, Any] = {}
    visited: list[str] = []
    completed_node_ids: list[str] = []
    branch_path: str | None = None
    status = "completed"
    error_message: str | None = None

    async def ensure_active(node_id: str | None) -> None:
        await run_workflow_blocking(
            _ensure_workflow_item_active,
            item_id,
            execution_generation,
            node_results=node_results,
            branch_path=branch_path,
            visited=visited,
            completed_node_ids=completed_node_ids,
            current_node_id=node_id,
        )

    async def save_progress(node_id: str | None = None, kind: str | None = None, label: str | None = None) -> None:
        await run_workflow_blocking(
            _save_workflow_item_progress_by_id,
            item_id,
            execution_generation,
            node_results=node_results,
            branch_path=branch_path,
            visited=visited,
            completed_node_ids=completed_node_ids,
            current_node_id=node_id,
            current_node_kind=kind,
            current_node_label=label,
        )

    while current_id:
        await ensure_active(current_id)
        if current_id in visited:
            raise RuntimeError("Workflow cycle detected during execution")
        visited.append(current_id)
        node = graph.nodes[current_id]
        kind = _node_kind(node)
        await save_progress(current_id, kind, _node_label(node))
        if kind == "classifier":
            if _execute_classifier_node is not _ORIGINAL_EXECUTE_CLASSIFIER_NODE:
                node_result = await run_workflow_blocking(_execute_node_compat, item_id, document_id, node, _execute_classifier_node)
                node_results[current_id] = node_result
                await ensure_active(current_id)
                if node_result["status"] == "failed":
                    status = "failed"
                    error_message = node_result.get("error_message")
                    break
                completed_node_ids.append(current_id)
                await save_progress()
                current_id = _single_next_node_id(graph, current_id)
                continue
            classifier_id = _node_config_value(node, "classifier_id")
            job_id = await run_workflow_blocking(_create_classification_job, document_id, classifier_id)
            node_results[current_id] = {"kind": "classifier", "status": "running", "job_id": job_id, "classifier_id": classifier_id}
            await save_progress(current_id, kind, _node_label(node))
            await ensure_active(current_id)
            await run_classification_job_async(job_id)
            await ensure_active(current_id)
            node_result = await run_workflow_blocking(_classification_node_result, job_id, classifier_id)
            node_results[current_id] = node_result
            if node_result["status"] == "failed":
                status = "failed"
                error_message = node_result.get("error_message")
                break
            completed_node_ids.append(current_id)
            await save_progress()
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
            await save_progress()
            current_id = branch_edge["target"]
            continue
        if kind == "kie":
            schema_id = _node_config_value(node, "schema_id")
            job_id = await run_workflow_blocking(_create_extraction_job, document_id, schema_id)
            node_results[current_id] = {"kind": "kie", "status": "running", "job_id": job_id, "schema_id": schema_id}
            await save_progress(current_id, kind, _node_label(node))
            await ensure_active(current_id)
            await run_extraction_job_async(job_id)
            await ensure_active(current_id)
            node_result = await run_workflow_blocking(_kie_node_result, job_id, schema_id)
            node_results[current_id] = node_result
            if node_result["status"] == "failed":
                status = "failed"
                error_message = node_result.get("error_message")
                break
            if node_result["status"] == "needs_review":
                status = "needs_review"
            completed_node_ids.append(current_id)
            await save_progress()
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "required-checker":
            checklist_id = _node_config_value(node, "checklist_id")
            job_id = await run_workflow_blocking(_create_required_job, document_id, checklist_id)
            node_results[current_id] = {
                "kind": "required-checker",
                "status": "running",
                "job_id": job_id,
                "checklist_id": checklist_id,
            }
            await save_progress(current_id, kind, _node_label(node))
            await ensure_active(current_id)
            await run_required_field_check_job_async(job_id)
            await ensure_active(current_id)
            node_result = await run_workflow_blocking(_required_node_result, job_id, checklist_id)
            node_results[current_id] = node_result
            if node_result["status"] == "failed":
                status = "failed"
                error_message = node_result.get("error_message")
                break
            overall = node_result.get("required_check", {}).get("overall_status")
            if node_result["status"] == "needs_review" or overall in {"incomplete", "needs_review"}:
                status = "needs_review"
            completed_node_ids.append(current_id)
            await save_progress()
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "merge":
            node_results[current_id] = {"kind": kind, "status": "completed"}
            completed_node_ids.append(current_id)
            await save_progress()
            current_id = _single_next_node_id(graph, current_id)
            continue
        if kind == "export":
            node_results[current_id] = {"kind": kind, "status": "completed"}
            completed_node_ids.append(current_id)
            break
        current_id = _single_next_node_id(graph, current_id)

    summary = _workflow_summary(node_results, branch_path)
    return {
        "document_id": document_id,
        "filename": filename,
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


def _create_classification_job(document_id: str, classifier_id: str) -> str:
    db = SessionLocal()
    try:
        document = db.get(Document, document_id)
        job = ClassificationJob(
            workspace_id=document.workspace_id if document else None,
            document_id=document_id,
            classifier_id=classifier_id,
            status="queued",
        )
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
        return job.id
    finally:
        db.close()


def _classification_node_result(job_id: str, classifier_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        loaded = db.get(ClassificationJob, job_id)
        if not loaded:
            return {"kind": "classifier", "status": "failed", "job_id": job_id, "error_message": "Classification job disappeared"}
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
    finally:
        db.close()


def _create_extraction_job(document_id: str, schema_id: str) -> str:
    db = SessionLocal()
    try:
        document = db.get(Document, document_id)
        job = ExtractionJob(
            workspace_id=document.workspace_id if document else None,
            document_id=document_id,
            schema_id=schema_id,
            schema_version=1,
            status="queued",
        )
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
        return job.id
    finally:
        db.close()


def _kie_node_result(job_id: str, schema_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        loaded = db.get(ExtractionJob, job_id)
        if not loaded:
            return {"kind": "kie", "status": "failed", "job_id": job_id, "error_message": "Extraction job disappeared"}
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
    finally:
        db.close()


def _create_required_job(document_id: str, checklist_id: str) -> str:
    db = SessionLocal()
    try:
        document = db.get(Document, document_id)
        job = RequiredFieldCheckJob(
            workspace_id=document.workspace_id if document else None,
            document_id=document_id,
            checklist_id=checklist_id,
            status="queued",
        )
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
        return job.id
    finally:
        db.close()


def _required_node_result(job_id: str, checklist_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        loaded = db.get(RequiredFieldCheckJob, job_id)
        if not loaded:
            return {"kind": "required-checker", "status": "failed", "job_id": job_id, "error_message": "Required check job disappeared"}
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
    finally:
        db.close()


def _execute_classifier_node(db: Session, document_id: str, node: dict[str, Any]) -> dict[str, Any]:
    classifier_id = _node_config_value(node, "classifier_id")
    document = db.get(Document, document_id)
    job = ClassificationJob(
        workspace_id=document.workspace_id if document else None,
        document_id=document_id,
        classifier_id=classifier_id,
        status="queued",
    )
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
    document = db.get(Document, document_id)
    job = ExtractionJob(
        workspace_id=document.workspace_id if document else None,
        document_id=document_id,
        schema_id=schema_id,
        schema_version=1,
        status="queued",
    )
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
    document = db.get(Document, document_id)
    job = RequiredFieldCheckJob(
        workspace_id=document.workspace_id if document else None,
        document_id=document_id,
        checklist_id=checklist_id,
        status="queued",
    )
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


_ORIGINAL_EXECUTE_CLASSIFIER_NODE = _execute_classifier_node
_ORIGINAL_EXECUTE_KIE_NODE = _execute_kie_node
_ORIGINAL_EXECUTE_REQUIRED_NODE = _execute_required_node


def _execute_node_compat(item_id: str, document_id: str, node: dict[str, Any], executor) -> dict[str, Any]:
    db = SessionLocal()
    try:
        item = db.get(WorkflowRunItem, item_id)
        if not item:
            raise WorkflowStopped()
        return executor(db, document_id, node)
    finally:
        db.close()


def _finalize_workflow_run(run_id: str, execution_generation: int | None = None) -> None:
    dispatch_next: tuple[str, int] | None = None
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
        elif any(status in {"queued", "running", "preprocessing", "waiting_for_document"} for status in statuses):
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
        if run.status in WORKFLOW_QUEUE_ADVANCE_STATUSES:
            dispatch_next = _activate_next_waiting_workflow_run(db, run, now)
        db.commit()
    finally:
        db.close()
    if dispatch_next:
        _dispatch_workflow_run_async(*dispatch_next)


def _activate_next_waiting_workflow_run(db: Session, completed_run: WorkflowRun, now: datetime) -> tuple[str, int] | None:
    group_id = completed_run.workflow_run_group_id or completed_run.id
    next_run = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.workflow_run_group_id == group_id, WorkflowRun.status == "waiting")
        .order_by(WorkflowRun.queue_order.asc(), WorkflowRun.created_at.asc(), WorkflowRun.id.asc())
        .first()
    )
    if not next_run:
        return None

    queued_count = 0
    next_run.execution_generation = (next_run.execution_generation or 0) + 1
    next_run.status = "running"
    next_run.completed_at = None
    next_run.error_message = None
    next_run.started_at = next_run.started_at or now
    next_run.inference_started_at = now
    for item in next_run.items:
        if item.status == "queued":
            item.error_message = None
            item.completed_at = None
            item.execution_generation = next_run.execution_generation
            queued_count += 1

    if not queued_count:
        next_run.status = "completed_with_errors"
        next_run.completed_at = now
        next_run.inference_started_at = None
        return None

    log_audit_event(
        db,
        entity_type="workflow_run",
        entity_id=next_run.id,
        action="queue_started",
        message=f"Started waiting workflow run after {completed_run.id}",
        metadata={
            "workflow_id": next_run.workflow_id,
            "queue_group_id": group_id,
            "previous_run_id": completed_run.id,
            "queue_order": next_run.queue_order,
            "queued_count": queued_count,
        },
    )
    return next_run.id, next_run.execution_generation


def _dispatch_workflow_run_async(run_id: str, execution_generation: int) -> None:
    thread = threading.Thread(target=run_workflow_run, args=(run_id, execution_generation), daemon=True)
    thread.start()


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


def _validate_config_references(graph: WorkflowGraph, db: Session, *, workspace_id: str | None = None) -> list[str]:
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
            if not classifier or classifier.archived or (workspace_id is not None and classifier.workspace_id != workspace_id):
                errors.append(f"Classifier node {node_id} must select a saved classifier")
        if kind == "kie":
            schema_id = _node_config_value(node, "schema_id")
            schema = db.get(Schema, schema_id) if schema_id else None
            if not schema or schema.archived or schema.ephemeral or (workspace_id is not None and schema.workspace_id != workspace_id):
                errors.append(f"KIE node {node_id} must select a saved schema")
        if kind == "required-checker":
            checklist_id = _node_config_value(node, "checklist_id")
            checklist = db.get(RequiredFieldChecklist, checklist_id) if checklist_id else None
            if not checklist or checklist.archived or (workspace_id is not None and checklist.workspace_id != workspace_id):
                errors.append(f"Required Field Checker node {node_id} must select a saved checklist")
    return errors


def _workflow_warnings(graph: WorkflowGraph, db: Session, *, workspace_id: str | None = None) -> list[str]:
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
        if not classifier or (workspace_id is not None and classifier.workspace_id != workspace_id):
            continue
        config = _json_or_empty(classifier.config_json)
        for candidate in config.get("classes", []):
            class_name = candidate.get("class_name") if isinstance(candidate, dict) else None
            if class_name and f"class:{class_name}" not in edge_keys:
                warnings.append(f"Branch node {node_id} has no path for class {class_name}")
    return warnings


def _workflow_run_status(run: WorkflowRun, items: list[WorkflowRunItem]) -> str:
    return _workflow_run_status_from_counts(run, _workflow_item_status_counts(items))


def _workflow_run_status_from_counts(run: WorkflowRun, status_counts: dict[str, int]) -> str:
    if run.status in WORKFLOW_TERMINAL_STATUSES or run.status in {"completed_with_errors", "failed"}:
        return run.status
    if run.status == "waiting":
        return "waiting"
    if run.status == "paused":
        return "paused"
    uploaded_count = sum(status_counts.values())
    if uploaded_count < run.total_count:
        return "uploading"
    if not uploaded_count:
        return run.status
    if status_counts.get("preprocessing", 0) or status_counts.get("waiting_for_document", 0):
        return "preprocessing"
    if status_counts.get("running", 0):
        return "running"
    if status_counts.get("paused", 0):
        return "paused"
    if run.status == "running" and status_counts.get("queued", 0):
        return "running"
    if status_counts.get("queued", 0):
        return "queued"
    if status_counts.get("failed", 0):
        return "completed_with_errors"
    if status_counts.get("needs_review", 0):
        return "needs_review"
    return "completed"


def _workflow_item_sort_key(item: WorkflowRunItem) -> tuple[int, int, str, str]:
    if item.upload_index is None:
        return (1, 0, item.filename.casefold(), item.id)
    return (0, item.upload_index, item.filename.casefold(), item.id)


def _workflow_item_status_counts(items: list[WorkflowRunItem]) -> dict[str, int]:
    return dict(Counter(item.status for item in items))


def _workflow_run_status_counts_from_db(run_id: str, db: Session) -> dict[str, int]:
    rows = (
        db.query(WorkflowRunItem.status, func.count(WorkflowRunItem.id))
        .filter(WorkflowRunItem.run_id == run_id)
        .group_by(WorkflowRunItem.status)
        .all()
    )
    return {status: int(count) for status, count in rows}


def _workflow_run_status_counts_for_runs(run_ids: list[str], db: Session) -> dict[str, dict[str, int]]:
    if not run_ids:
        return {}
    rows = (
        db.query(WorkflowRunItem.run_id, WorkflowRunItem.status, func.count(WorkflowRunItem.id))
        .filter(WorkflowRunItem.run_id.in_(run_ids))
        .group_by(WorkflowRunItem.run_id, WorkflowRunItem.status)
        .all()
    )
    counts: dict[str, dict[str, int]] = {run_id: {} for run_id in run_ids}
    for run_id, status, count in rows:
        counts.setdefault(run_id, {})[status] = int(count)
    return counts


def _workflow_terminal_count(status_counts: dict[str, int]) -> int:
    return sum(count for status, count in status_counts.items() if status in WORKFLOW_TERMINAL_STATUSES)


def _workflow_run_counters(run: WorkflowRun, items: list[WorkflowRunItem]) -> dict[str, Any]:
    return _workflow_run_counters_from_status_counts(run, _workflow_item_status_counts(items))


def _workflow_run_counters_from_status_counts(run: WorkflowRun, status_counts: dict[str, int]) -> dict[str, Any]:
    uploaded_count = sum(status_counts.values())
    completed_count = status_counts.get("completed", 0)
    terminal_count = _workflow_terminal_count(status_counts)
    preprocessing_count = status_counts.get("preprocessing", 0) + status_counts.get("waiting_for_document", 0)
    queued_count = status_counts.get("queued", 0)
    running_count = status_counts.get("running", 0)
    canceled_count = status_counts.get("canceled", 0)
    paused_count = status_counts.get("paused", 0)
    status = _workflow_run_status_from_counts(run, status_counts)
    if status == "waiting":
        progress_phase = "waiting"
    elif status == "paused" or paused_count:
        progress_phase = "paused"
    elif uploaded_count < run.total_count:
        progress_phase = "uploading"
    elif preprocessing_count:
        progress_phase = "preprocessing"
    elif running_count or (run.status == "running" and queued_count):
        progress_phase = "running"
    else:
        progress_phase = status
    return {
        "status": status,
        "uploaded_count": uploaded_count,
        "completed_count": completed_count,
        "preprocessing_count": preprocessing_count,
        "ready_count": max(0, uploaded_count - preprocessing_count),
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
