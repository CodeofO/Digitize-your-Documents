#!/usr/bin/env python3
"""Run the bank PoC demo UI smoke against an ephemeral database."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


TERMINAL_RUN_STATUSES = {"completed", "completed_with_errors", "needs_review", "failed", "canceled"}
TERMINAL_EXPORT_STATUSES = {"completed", "failed"}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the bank PoC seed/run/export and UI routes without writing to the project DB."
    )
    parser.add_argument("--skip-browser", action="store_true", help="Run only API checks and skip Chrome screenshots.")
    parser.add_argument("--keep-work-dir", action="store_true", help="Keep the temporary DB/storage directory for debugging.")
    parser.add_argument("--artifact-dir", default="", help="Directory where screenshots should be written.")
    parser.add_argument("--browser-timeout", type=float, default=30.0, help="Timeout in seconds for each Chrome screenshot.")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    python_bin = root / ".venv" / "bin" / "python"
    if not python_bin.exists():
        print(f"Python virtualenv not found: {python_bin}", file=sys.stderr)
        return 2

    work_dir = Path(tempfile.mkdtemp(prefix="daw_poc_ui_smoke_"))
    artifact_dir = Path(args.artifact_dir).resolve() if args.artifact_dir else Path(
        tempfile.mkdtemp(prefix="daw_poc_ui_screens_")
    )
    artifact_dir.mkdir(parents=True, exist_ok=True)
    backend_port = _free_port()
    frontend_port = _free_port()
    backend_base = f"http://127.0.0.1:{backend_port}"
    frontend_base = f"http://127.0.0.1:{frontend_port}"
    processes: list[subprocess.Popen[str]] = []
    db_path = work_dir / "poc_ui.db"

    try:
        backend_env = os.environ.copy()
        backend_env.update(
            {
                "APP_ENV": "local",
                "DATABASE_URL": f"sqlite:///{db_path}",
                "DOCUMENT_STORAGE_DIR": str(work_dir / "documents"),
                "RAW_STORAGE_DIR": str(work_dir / "raw"),
                "PROCESSING_TMP_DIR": str(work_dir / "processing"),
                "EXPORT_STORAGE_DIR": str(work_dir / "exports"),
                "VLM_PROVIDER": "mock",
                "VLM_MODEL_NAME": "mock-vlm",
                "UPLOAD_RETENTION_HOURS": "24",
                "PYTHONUNBUFFERED": "1",
            }
        )
        frontend_env = os.environ.copy()
        frontend_env.update({"VITE_API_BASE_URL": backend_base})

        processes.append(
            subprocess.Popen(
                [
                    str(python_bin),
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--app-dir",
                    "backend",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(backend_port),
                ],
                cwd=root,
                env=backend_env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                text=True,
            )
        )
        _wait_for_url(f"{backend_base}/api/health", "backend health", processes[0])

        processes.append(
            subprocess.Popen(
                ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(frontend_port)],
                cwd=root / "frontend",
                env=frontend_env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                text=True,
            )
        )
        _wait_for_url(frontend_base, "frontend dev server", processes[1])

        seeded = _api_json(backend_base, "POST", "/api/templates/bank-documents-poc/seed")
        _assert_seed_payload(seeded)
        document_ids = [document["document_id"] for document in seeded.get("sample_documents", [])]
        if len(document_ids) < 3:
            raise AssertionError(f"expected at least 3 sample documents, got {len(document_ids)}")
        for document_id in document_ids:
            _wait_for_document_ready(backend_base, document_id)

        run = _api_json(
            backend_base,
            "POST",
            f"/api/workflows/{seeded['workflow']['id']}/runs/from-documents",
            {"document_ids": document_ids},
        )
        run = _wait_for_workflow_terminal(backend_base, run["id"])
        if run["status"] in {"failed", "canceled"}:
            raise AssertionError(f"workflow ended in {run['status']}: {run.get('error_message')}")

        export_job = _api_json(
            backend_base,
            "POST",
            "/api/export-jobs",
            {"owner_type": "workflow_run", "owner_id": run["id"], "format": "xlsx"},
            expected_status=202,
        )
        export_job = _wait_for_export_job(backend_base, export_job["id"])
        if export_job["status"] != "completed":
            raise AssertionError(f"export failed: {export_job.get('error_message')}")
        _assert_xlsx_download(backend_base, export_job["id"])

        screenshot_paths: list[Path] = []
        if not args.skip_browser:
            screenshot_paths = _capture_ui_screenshots(frontend_base, run["id"], artifact_dir, args.browser_timeout)

        if not db_path.exists():
            raise AssertionError(f"ephemeral database was not created: {db_path}")
        print(f"poc ui smoke passed: db={db_path}")
        if screenshot_paths:
            print("screenshots:")
            for screenshot_path in screenshot_paths:
                print(f"  {screenshot_path}")
        return 0
    finally:
        for process in reversed(processes):
            _terminate(process)
        if not args.keep_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)
            print(f"ephemeral DB/storage removed: {work_dir}")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_url(url: str, label: str, process: subprocess.Popen[str], timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"{label} process exited with {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 400:
                    return
        except Exception:
            time.sleep(0.25)
    raise AssertionError(f"{label} did not respond at {url}")


def _api_json(
    base_url: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    expected_status: int = 200,
) -> dict[str, Any]:
    body = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{base_url}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read()
            if response.status != expected_status:
                raise AssertionError(f"{method} {path} returned {response.status}: {data[:200]!r}")
            return json.loads(data.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise AssertionError(f"{method} {path} returned {exc.code}: {detail[:500]}") from exc


def _assert_seed_payload(seeded: dict[str, Any]) -> None:
    payload_text = json.dumps(seeded, ensure_ascii=False)
    for expected in ["신청서", "동의서", "증빙문서", "class:신청서", "class:동의서", "class:증빙문서"]:
        if expected not in payload_text:
            raise AssertionError(f"seed payload does not include Korean demo label: {expected}")
    nodes = {
        node.get("id"): node
        for node in seeded.get("workflow", {}).get("definition", {}).get("nodes", [])
        if isinstance(node, dict)
    }
    expected_positions = {
        "input": {"x": 40, "y": 240},
        "classifier": {"x": 250, "y": 240},
        "branch": {"x": 460, "y": 210},
        "kie_application": {"x": 670, "y": 70},
        "required_application": {"x": 900, "y": 70},
        "required_consent": {"x": 670, "y": 240},
        "kie_supporting": {"x": 670, "y": 410},
        "merge": {"x": 900, "y": 300},
        "export": {"x": 1110, "y": 300},
    }
    for node_id, position in expected_positions.items():
        if nodes.get(node_id, {}).get("position") != position:
            raise AssertionError(f"seed payload has unexpected canvas position for {node_id}: {nodes.get(node_id)}")


def _wait_for_document_ready(base_url: str, document_id: str) -> dict[str, Any]:
    for _ in range(120):
        payload = _api_json(base_url, "GET", f"/api/documents/{document_id}")
        if payload["status"] == "ready":
            return payload
        if payload["status"] in {"failed", "deleted"}:
            raise AssertionError(f"document failed: {payload.get('error_message')}")
        time.sleep(0.1)
    raise AssertionError(f"document did not become ready: {document_id}")


def _wait_for_workflow_terminal(base_url: str, run_id: str) -> dict[str, Any]:
    for _ in range(160):
        payload = _api_json(base_url, "GET", f"/api/workflow-runs/{run_id}/summary")
        if payload["status"] in TERMINAL_RUN_STATUSES:
            return _api_json(base_url, "GET", f"/api/workflow-runs/{run_id}")
        time.sleep(0.1)
    raise AssertionError(f"workflow did not finish: {run_id}")


def _wait_for_export_job(base_url: str, job_id: str) -> dict[str, Any]:
    for _ in range(120):
        payload = _api_json(base_url, "GET", f"/api/export-jobs/{job_id}")
        if payload["status"] in TERMINAL_EXPORT_STATUSES:
            return payload
        time.sleep(0.1)
    raise AssertionError(f"export job did not finish: {job_id}")


def _assert_xlsx_download(base_url: str, job_id: str) -> None:
    with urllib.request.urlopen(f"{base_url}/api/export-jobs/{job_id}/download", timeout=20) as response:
        content = response.read(4)
        if response.status != 200 or content != b"PK\x03\x04":
            raise AssertionError(f"xlsx download failed: {response.status} {content!r}")


def _capture_ui_screenshots(frontend_base: str, run_id: str, artifact_dir: Path, timeout: float) -> list[Path]:
    chrome = _chrome_binary()
    if not chrome:
        raise AssertionError("Chrome binary not found. Rerun with --skip-browser to do API-only smoke.")

    profile_dir = Path(tempfile.mkdtemp(prefix="daw_poc_chrome_profile_"))
    captures = [
        ("workflow-desktop", f"{frontend_base}/#workflow", "1440,900"),
        ("result-desktop", f"{frontend_base}/#workflow-result:{run_id}", "1440,900"),
        ("result-narrow", f"{frontend_base}/#workflow-result:{run_id}", "820,1180"),
    ]
    screenshot_paths: list[Path] = []
    try:
        for name, url, window_size in captures:
            screenshot_path = artifact_dir / f"{name}.png"
            command = [
                str(chrome),
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--disable-extensions",
                f"--user-data-dir={profile_dir}",
                f"--window-size={window_size}",
                "--virtual-time-budget=6000",
                f"--screenshot={screenshot_path}",
                url,
            ]
            timed_out = False
            try:
                result = subprocess.run(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired as exc:
                if not _screenshot_is_valid(screenshot_path):
                    raise AssertionError(f"Chrome screenshot timed out for {name} after {timeout:.1f}s") from exc
                timed_out = True
                result = None
            if result is not None and result.returncode != 0:
                raise AssertionError(f"Chrome screenshot failed for {name}: {result.stderr[-500:]}")
            if not _screenshot_is_valid(screenshot_path):
                raise AssertionError(f"Chrome screenshot looks empty: {screenshot_path}")
            if timed_out:
                print(f"Chrome screenshot captured before timeout: {screenshot_path}", flush=True)
            screenshot_paths.append(screenshot_path)
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)
    return screenshot_paths


def _screenshot_is_valid(path: Path) -> bool:
    return path.exists() and path.stat().st_size >= 10_000


def _chrome_binary() -> Path | None:
    candidates = [
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    for name in ["google-chrome", "chromium", "chromium-browser"]:
        resolved = shutil.which(name)
        if resolved:
            return Path(resolved)
    return None


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=8)


if __name__ == "__main__":
    raise SystemExit(main())
