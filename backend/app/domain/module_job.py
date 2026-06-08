from datetime import datetime
from typing import Any


TERMINAL_MODULE_JOB_STATUSES = {"completed", "needs_review", "failed", "canceled"}


class ModuleJobLifecycle:
    def __init__(self, job: Any) -> None:
        self._job = job

    @property
    def is_terminal(self) -> bool:
        return self._job.status in TERMINAL_MODULE_JOB_STATUSES

    def mark_running(self, now: datetime) -> None:
        self._job.status = "running"
        self._job.started_at = now

    def complete(self, now: datetime) -> None:
        self._job.status = "completed"
        self._job.completed_at = now

    def needs_review(self, now: datetime) -> None:
        self._job.status = "needs_review"
        self._job.completed_at = now

    def fail(self, message: str, now: datetime) -> None:
        self._job.status = "failed"
        self._job.error_message = message
        self._job.completed_at = now

    def cancel(self, message: str, now: datetime) -> None:
        self._job.status = "canceled"
        self._job.error_message = message
        self._job.completed_at = now
