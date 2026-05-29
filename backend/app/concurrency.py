import asyncio
import functools
import threading
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

from app.config import get_settings


T = TypeVar("T")

_WORKFLOW_SLOT_LOCK = threading.Lock()
_WORKFLOW_SLOT_LIMIT = 0
_WORKFLOW_EXECUTOR: ThreadPoolExecutor | None = None


def workflow_worker_limit() -> int:
    return max(1, get_settings().workflow_max_workers)


def workflow_worker_executor() -> ThreadPoolExecutor:
    global _WORKFLOW_SLOT_LIMIT, _WORKFLOW_EXECUTOR
    limit = workflow_worker_limit()
    with _WORKFLOW_SLOT_LOCK:
        if _WORKFLOW_EXECUTOR is None or _WORKFLOW_SLOT_LIMIT != limit:
            old_executor = _WORKFLOW_EXECUTOR
            _WORKFLOW_SLOT_LIMIT = limit
            _WORKFLOW_EXECUTOR = ThreadPoolExecutor(max_workers=limit, thread_name_prefix="workflow-local")
            if old_executor is not None:
                old_executor.shutdown(wait=False, cancel_futures=False)
        return _WORKFLOW_EXECUTOR


async def run_workflow_blocking(func: Callable[..., T], *args, **kwargs) -> T:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(workflow_worker_executor(), functools.partial(func, *args, **kwargs))


async def gather_workflow_limited(
    items: list[T],
    runner: Callable[[T], Awaitable[Any]],
    *,
    return_exceptions: bool = False,
) -> list[Any]:
    if not items:
        return []

    queue: asyncio.Queue[tuple[int, T]] = asyncio.Queue()
    for index, item in enumerate(items):
        queue.put_nowait((index, item))

    results: list[Any] = [None] * len(items)
    worker_count = min(workflow_worker_limit(), len(items))

    async def worker() -> None:
        while True:
            try:
                index, item = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            try:
                results[index] = await runner(item)
            except Exception as exc:
                if not return_exceptions:
                    raise
                results[index] = exc
            finally:
                queue.task_done()

    tasks = [asyncio.create_task(worker()) for _ in range(worker_count)]
    try:
        await asyncio.gather(*tasks)
    except Exception:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    return results
