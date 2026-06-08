from collections.abc import Callable
from datetime import datetime
from typing import Any


WORKFLOW_RUN_TERMINAL_STATUSES = {"completed", "completed_with_errors", "needs_review", "failed", "canceled"}
ACTIVE_WORKFLOW_ITEM_STATUSES = {"queued", "preprocessing", "running", "paused"}


class WorkflowRunLifecycle:
    def __init__(self, run: Any) -> None:
        self._run = run

    @property
    def is_terminal(self) -> bool:
        return self._run.status in WORKFLOW_RUN_TERMINAL_STATUSES

    def start(self, now: datetime, *, upload_duration_ms: int | None) -> int:
        self._run.execution_generation = (self._run.execution_generation or 0) + 1
        self._run.status = "running"
        self._run.upload_duration_ms = upload_duration_ms
        self._run.started_at = self._run.started_at or now
        self._run.inference_started_at = now
        for item in self._run.items:
            if item.status in {"queued", "paused"}:
                item.status = "queued"
                item.error_message = None
                item.completed_at = None
                item.execution_generation = self._run.execution_generation
        return self._run.execution_generation

    def prepare_resume(self, now: datetime) -> int:
        queued_count = 0
        for item in self._run.items:
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

    def finish_resume(self, now: datetime, *, queued_count: int, fallback_status: str) -> int:
        self._run.status = "running" if queued_count else fallback_status
        self._run.completed_at = None if queued_count else self._run.completed_at
        if not queued_count:
            return self._run.execution_generation or 0
        self._run.execution_generation = (self._run.execution_generation or 0) + 1
        self._run.started_at = self._run.started_at or now
        self._run.inference_started_at = now
        for item in self._run.items:
            if item.status == "queued":
                item.execution_generation = self._run.execution_generation
        return self._run.execution_generation

    def pause(self, now: datetime, *, cancel_active_job: Callable[[Any], None]) -> int:
        paused_count = 0
        self._run.execution_generation = (self._run.execution_generation or 0) + 1
        for item in self._run.items:
            if item.status in {"queued", "preprocessing", "running"}:
                cancel_active_job(item)
                item.status = "paused"
                item.error_message = "Paused by user"
                item.completed_at = now
                paused_count += 1
        self._run.status = "paused"
        self._run.completed_at = None
        self._run.error_message = "Paused by user"
        return paused_count

    def prepare_restart(self, now: datetime, *, initial_payload: Callable[[Any], str]) -> int:
        queued_count = 0
        for item in self._run.items:
            if item.document and item.document.status == "ready" and item.document.pages:
                item.status = "queued"
                item.error_message = None
                item.completed_at = None
                item.inference_duration_ms = None
                item.execution_generation = self._run.execution_generation
                item.result_json = initial_payload(item.document)
                queued_count += 1
            else:
                item.status = "failed"
                item.error_message = item.document.error_message if item.document else "Document preprocessing was interrupted"
                item.completed_at = now
                item.execution_generation = self._run.execution_generation
        return queued_count

    def prepare_retry_failed(self, now: datetime, *, initial_payload: Callable[[Any], str]) -> int:
        queued_count = 0
        for item in self._run.items:
            if item.status != "failed":
                continue
            if item.document and item.document.status == "ready" and item.document.pages:
                item.status = "queued"
                item.error_message = None
                item.completed_at = None
                item.inference_duration_ms = None
                item.execution_generation = self._run.execution_generation
                item.result_json = initial_payload(item.document)
                queued_count += 1
            else:
                item.error_message = item.document.error_message if item.document else "Document preprocessing was interrupted"
                item.completed_at = now
                item.execution_generation = self._run.execution_generation
        return queued_count

    def mark_retry_running(self, now: datetime) -> None:
        self._run.status = "running"
        self._run.completed_at = None
        self._run.error_message = None
        self._run.started_at = self._run.started_at or now
        self._run.inference_started_at = now

    def cancel_waiting(self, now: datetime, *, message: str) -> int:
        canceled_count = 0
        for item in self._run.items:
            if item.status in ACTIVE_WORKFLOW_ITEM_STATUSES:
                item.status = "canceled"
                item.error_message = message
                item.completed_at = now
                canceled_count += 1
        self._run.status = "canceled"
        self._run.error_message = message
        self._run.completed_at = now
        self._run.inference_started_at = None
        return canceled_count

    def stop_without_deleting_documents(
        self,
        now: datetime,
        *,
        message: str,
        cancel_active_job: Callable[[Any], None],
    ) -> int:
        stopped_count = 0
        self._run.execution_generation = (self._run.execution_generation or 0) + 1
        for item in self._run.items:
            if item.status in ACTIVE_WORKFLOW_ITEM_STATUSES:
                cancel_active_job(item)
                item.status = "canceled"
                item.error_message = message
                item.completed_at = now
                stopped_count += 1
        self._run.status = "canceled"
        self._run.error_message = message
        self._run.completed_at = now
        self._run.inference_started_at = None
        return stopped_count
