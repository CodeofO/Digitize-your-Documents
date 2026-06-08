from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.domain.workflow_run import WorkflowRunLifecycle


@dataclass(frozen=True)
class WorkflowRunStartResult:
    execution_generation: int


@dataclass(frozen=True)
class WorkflowRunResumeResult:
    queued_count: int
    execution_generation: int


@dataclass(frozen=True)
class WorkflowRunPauseResult:
    paused_count: int


@dataclass(frozen=True)
class WorkflowRunRetryFailedResult:
    queued_count: int


class WorkflowRunApplicationService:
    def start(self, run: Any, now: datetime, *, upload_duration_ms: int | None) -> WorkflowRunStartResult:
        generation = WorkflowRunLifecycle(run).start(now, upload_duration_ms=upload_duration_ms)
        return WorkflowRunStartResult(execution_generation=generation)

    def resume(self, run: Any, now: datetime, *, fallback_status: Callable[[], str]) -> WorkflowRunResumeResult:
        lifecycle = WorkflowRunLifecycle(run)
        queued_count = lifecycle.prepare_resume(now)
        generation = lifecycle.finish_resume(now, queued_count=queued_count, fallback_status=fallback_status())
        return WorkflowRunResumeResult(queued_count=queued_count, execution_generation=generation)

    def pause(
        self,
        run: Any,
        now: datetime,
        *,
        cancel_active_job: Callable[[Any], None],
    ) -> WorkflowRunPauseResult:
        paused_count = WorkflowRunLifecycle(run).pause(now, cancel_active_job=cancel_active_job)
        return WorkflowRunPauseResult(paused_count=paused_count)

    def retry_failed(
        self,
        run: Any,
        now: datetime,
        *,
        initial_payload: Callable[[Any], str],
    ) -> WorkflowRunRetryFailedResult:
        lifecycle = WorkflowRunLifecycle(run)
        queued_count = lifecycle.prepare_retry_failed(now, initial_payload=initial_payload)
        if queued_count:
            lifecycle.mark_retry_running(now)
        return WorkflowRunRetryFailedResult(queued_count=queued_count)
