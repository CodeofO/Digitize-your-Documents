# Digitize Your Document

Digitize Your Document is a React + FastAPI workspace for turning documents into structured digital outputs.

Current implemented tools:

- **Raw Data Extractor**: upload `.docx`, `.xlsx`, `.pptx`, or `.pdf`; generate a PDF preview and extracted HTML.
- **Key Information Extractor (KIE)**: upload PDF/image documents, define a schema, and extract schema-defined values with a VLM.

Planned tools:

- **OCR**: simple text OCR.
- **Intelligence Parse**: semantic document parsing beyond raw text/table extraction.

## Structure

```text
.
├── backend/                 # FastAPI, SQLite, document processing, VLM, raw extraction
├── frontend/                # Vite + React + TypeScript UI
├── sync_raw_to_pdf.py       # LibreOffice reference script used for raw PDF conversion design
├── KIE_development_definition.md
├── ERROR_NOTE.md
├── .env.example
└── README.md
```

## Environment

This project uses `uv` and a local `.venv`, not conda.

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'
```

Run the same install command whenever `backend/pyproject.toml` changes.

Backend reads root `.env` and `backend/.env`. Do not put real secrets in `.env.example`.

```env
APP_ENV=local
VLM_PROVIDER=openai
VLM_API_KEY=
VLM_MODEL_NAME=
VLM_BASE_URL=
VLM_TEMPERATURE=0
VLM_MAX_RETRIES=2
VLM_TIMEOUT_SECONDS=120
LIBREOFFICE_PATH=

OPENAI_API_KEY=
OPENAI_MODEL_NAME=
```

`LIBREOFFICE_PATH` is optional. On macOS the backend checks `/Applications/LibreOffice.app/Contents/MacOS/soffice` by default.

## LibreOffice

LibreOffice cannot be installed into `.venv` as a normal Python dependency. The backend uses the external `soffice` CLI for Office-to-PDF preview conversion, so LibreOffice must be installed at the OS level.

This machine currently has LibreOffice available at:

```bash
/Applications/LibreOffice.app/Contents/MacOS/soffice --version
which soffice
```

Expected local paths:

- `/Applications/LibreOffice.app/Contents/MacOS/soffice`
- `/usr/local/bin/soffice`

Install on macOS with Homebrew:

```bash
brew install --cask libreoffice
```

Or install from the official LibreOffice download page:

- https://www.libreoffice.org/download/download-libreoffice/
- https://www.libreoffice.org/get-help/install-howto/macos/

After installation, verify:

```bash
soffice --version
```

If `soffice` is installed in a non-standard location, set the explicit path in `.env`:

```env
LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

If LibreOffice is missing or the configured path is invalid, Raw Data Extractor marks the extraction as `failed` and returns an error message explaining that LibreOffice must be installed or `LIBREOFFICE_PATH` must be set.

Frontend only needs:

```bash
cp frontend/.env.example frontend/.env
```

## Run

Run both servers:

```bash
./scripts/run_dev.sh
```

Defaults:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:5173`

Run backend only:

```bash
.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Run frontend only:

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev -- --host 127.0.0.1 --port 5173
```

## Raw Data Extractor

Supported v1 formats:

- `.docx`
- `.xlsx`
- `.pptx`
- `.pdf`

Flow:

1. Upload a raw document.
2. Backend stores it in `backend/storage/raw/{id}/original.ext`.
3. Backend creates `preview.pdf`.
4. Backend extracts readable document information into `content.html`.
5. UI shows PDF preview on the left and HTML preview on the right.

Python parser strategy:

- `.docx`: `mammoth` to semantic HTML, then sanitized with `bleach`
- `.xlsx`: `openpyxl` read-only workbook parsing to sheet tables
- `.pptx`: `python-pptx` slide text/table extraction
- `.pdf`: PyMuPDF page text extraction

Office-to-PDF preview uses LibreOffice headless conversion. If LibreOffice is unavailable, the raw extraction row is returned with `status=failed` and an actionable error message.

Raw API:

- `POST /api/raw-extractions`
- `GET /api/raw-extractions?limit=20`
- `GET /api/raw-extractions/{id}`
- `GET /api/raw-extractions/{id}/pdf`
- `GET /api/raw-extractions/{id}/html`

## KIE

KIE remains available from the home screen.

Key APIs:

- `GET /api/health`
- `GET /api/system/status`
- `POST /api/documents`
- `GET /api/documents?limit=20`
- `POST /api/schemas`
- `GET /api/schemas`
- `PATCH /api/schemas/{schema_id}`
- `POST /api/schemas/recommendations`
- `POST /api/extraction-jobs`
- `GET /api/extraction-jobs/{job_id}`
- `PATCH /api/extraction-results/{result_id}`
- `GET /api/extraction-results/{result_id}/export?format=json|csv`

For local KIE demo without a real VLM:

```env
VLM_PROVIDER=mock
```

## Tests

Backend:

```bash
.venv/bin/python -m pytest backend
```

Frontend:

```bash
cd frontend
npm run build
```

The backend test suite mocks LibreOffice conversion for Office files. Use manual smoke tests with real LibreOffice installed for end-to-end PDF conversion.

## Notes

- SQLite DB defaults to `backend/kie.db`.
- Uploaded documents and raw extraction outputs are stored under `backend/storage/`.
- `.env`, `.venv`, local DBs, storage outputs, `node_modules`, and frontend build artifacts are ignored by git.
- OCR and Intelligence Parse are intentionally disabled in the UI until implemented.
