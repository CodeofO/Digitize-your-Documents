# Document Automation Workspace

Document Automation Workspace is a local-first document automation prototype for turning semi-structured files into reviewed, exportable data.

It combines document upload, schema-based key information extraction, document classification, required-field checks, batch execution, a visual workflow builder, and export jobs in one workspace.

## Highlights

- Document library with upload, folder movement, copy, delete, and selection workflows.
- Key information extraction with editable schemas, field regions, AI schema recommendations, field-level review, and JSON/CSV/XLSX export.
- Document classifier and required-field checker modules.
- Workflow Builder with document input, classifier, branch, KIE, required check, merge, and export nodes.
- AI workflow draft generation from up to 10 sample images.
- Inline schema editing inside Workflow Builder KIE nodes before saving the workflow.
- Batch and workflow run monitoring with retry, pause, cancel, result view, and export history.
- Mock VLM mode for local UI and smoke testing without external API calls.

## Quick Start

Requirements:

- Python 3.11
- Node.js 20+
- LibreOffice for DOCX/PPTX/XLSX conversion

Run both backend and frontend:

```bash
./scripts/run_dev.sh
```

Then open:

```text
http://127.0.0.1:5173/
```

The default local configuration can run with `VLM_PROVIDER=mock`. To call a real provider, copy `.env.example` to `.env` and set `VLM_PROVIDER`, `VLM_API_KEY`, and `VLM_MODEL_NAME`.

## Useful Commands

Backend tests:

```bash
cd backend
../.venv/bin/python -m pytest tests
```

Frontend build:

```bash
npm run build --prefix frontend
```

Large mock smoke:

```bash
./.venv/bin/python scripts/run_large_mock_smoke.py --count 1000
```

PoC UI smoke:

```bash
./.venv/bin/python scripts/run_poc_ui_smoke.py
```

## Public Scope

This public repository focuses on the document automation product surface: upload, extraction, classification, validation, workflow building, execution, review, and export.

Service-only concerns are intentionally not included here.
