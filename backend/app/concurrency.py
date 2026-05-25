import asyncio
import functools
import threading
from collections.abc import Callable
from typing import TypeVar

from app.config import get_settings


T = TypeVar("T")

_WORKFLOW_SLOT_LOCK = threading.Lock()
_WORKFLOW_SLOT_LIMIT = 0
_WORKFLOW_SLOT_SEMAPHORE: threading.BoundedSemaphore | None = None


def workflow_worker_limit() -> int:
    return max(1, get_settings().workflow_max_workers)


def workflow_worker_semaphore() -> threading.BoundedSemaphore:
    global _WORKFLOW_SLOT_LIMIT, _WORKFLOW_SLOT_SEMAPHORE
    limit = workflow_worker_limit()
    with _WORKFLOW_SLOT_LOCK:
        if _WORKFLOW_SLOT_SEMAPHORE is None or _WORKFLOW_SLOT_LIMIT != limit:
            _WORKFLOW_SLOT_LIMIT = limit
            _WORKFLOW_SLOT_SEMAPHORE = threading.BoundedSemaphore(limit)
        return _WORKFLOW_SLOT_SEMAPHORE


async def run_workflow_blocking(func: Callable[..., T], *args, **kwargs) -> T:
    semaphore = workflow_worker_semaphore()
    await asyncio.to_thread(semaphore.acquire)
    try:
        return await asyncio.to_thread(functools.partial(func, *args, **kwargs))
    finally:
        semaphore.release()
