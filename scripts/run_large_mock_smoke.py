#!/usr/bin/env python3
"""Seed a large mock workflow run and verify summary polling plus export."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify large workflow summary/export paths without calling a VLM provider.")
    parser.add_argument("--count", type=int, default=1000, help="Number of workflow items to seed.")
    parser.add_argument("--work-dir", default="", help="Optional directory for the temporary DB and storage.")
    args = parser.parse_args()
    if args.count < 1:
        raise SystemExit("--count must be positive")

    root = Path(__file__).resolve().parents[1]
    owns_work_dir = not args.work_dir
    work_dir = Path(args.work_dir).resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix="daw_large_smoke_"))
    work_dir.mkdir(parents=True, exist_ok=True)

    os.environ.update(
        {
            "APP_ENV": "local",
            "DATABASE_URL": f"sqlite:///{work_dir / 'large.db'}",
            "DOCUMENT_STORAGE_DIR": str(work_dir / "documents"),
            "RAW_STORAGE_DIR": str(work_dir / "raw"),
            "PROCESSING_TMP_DIR": str(work_dir / "processing"),
            "VLM_PROVIDER": "mock",
            "VLM_MODEL_NAME": "mock-vlm",
        }
    )
    sys.path.insert(0, str(root / "backend"))

    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.database import SessionLocal, engine, init_db
    from app.main import app
    from app.models import WorkflowDefinition, WorkflowRun, WorkflowRunItem

    try:
        get_settings.cache_clear()
        init_db()
        db = SessionLocal()
        try:
            workflow = WorkflowDefinition(name="large_mock_smoke_workflow", definition_json=json.dumps({"nodes": [], "edges": []}))
            db.add(workflow)
            db.flush()
            run = WorkflowRun(workflow_id=workflow.id, workflow_name=workflow.name, status="completed", total_count=args.count)
            db.add(run)
            db.flush()
            for index in range(args.count):
                status = "needs_review" if index % 10 == 0 else "completed"
                db.add(
                    WorkflowRunItem(
                        run_id=run.id,
                        document_id=f"doc_large_smoke_{index}",
                        filename=f"bank_document_{index:05d}.png",
                        upload_index=index,
                        status=status,
                        upload_duration_ms=1,
                        inference_duration_ms=2,
                        result_json=json.dumps(
                            {
                                "classification": {"status": "classified", "class_name": "contract", "confidence": 0.88},
                                "branch_path": "class:contract",
                                "kie_values": {
                                    "document_number": {"value": f"DOC-{index:05d}", "confidence": 0.9, "evidence": "mock"}
                                },
                                "required_overall_status": "complete",
                                "required_items": {"signature": {"status": "present", "evidence": "mock"}},
                            },
                            ensure_ascii=False,
                        ),
                    )
                )
            db.commit()
            run_id = run.id
        finally:
            db.close()

        with TestClient(app) as client:
            summary = assert_ok(client.get(f"/api/workflow-runs/{run_id}/summary"), "workflow summary")
            expected_needs_review = (args.count + 9) // 10
            if summary["items"] != []:
                raise AssertionError("summary endpoint returned item payloads")
            if summary["total_count"] != args.count or summary["needs_review_count"] != expected_needs_review:
                raise AssertionError(f"unexpected summary counters: {summary}")
            csv_response = client.get(f"/api/workflow-runs/{run_id}/export?format=csv")
            if csv_response.status_code != 200:
                raise AssertionError(f"csv export failed: {csv_response.status_code} {csv_response.text[:200]}")
            csv_text = csv_response.text
            if "kie_document_number" not in csv_text or f"bank_document_{args.count - 1:05d}.png" not in csv_text:
                raise AssertionError("csv export does not include expected union columns or final row")

        print(f"large mock smoke passed: count={args.count} work_dir={work_dir}")
        return 0
    finally:
        engine.dispose()
        if owns_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)
            print(f"ephemeral large-smoke DB/storage removed: {work_dir}")


def assert_ok(response, label: str):
    if response.status_code != 200:
        raise AssertionError(f"{label} failed: {response.status_code} {response.text}")
    return response.json()


if __name__ == "__main__":
    raise SystemExit(main())
