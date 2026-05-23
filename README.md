<div align="center">
  <h1>Document Automation Workspace</h1>
  <p><b>문서 분류, 필수 항목 검수, 핵심 정보 추출, export를 하나의 워크플로우로 연결하는 문서 자동화 앱입니다.</b></p>
  <p>
    <code>Workflow Builder</code>
    <code>Document Classifier</code>
    <code>Required Field Checker</code>
    <code>Key Information Extractor</code>
    <code>Batch Export</code>
  </p>
</div>

![Document Automation Workspace overview](assets/readme/overview.png)

## Demo

- Demo URL: `https://0ece-1-235-8-46.ngrok-free.app`
- Access code: 별도 공유

외부 데모는 `scripts/start_hosting_demo.sh`로 production 모드와 동일한 단일 서버 구성을 띄운 뒤 ngrok HTTPS URL로 확인합니다.

```bash
ACCESS_CODE=<shared-code> ./scripts/start_hosting_demo.sh
```

고정 ngrok domain을 사용할 때:

```bash
NGROK_URL=https://your-domain.ngrok.app ACCESS_CODE=<shared-code> ./scripts/start_hosting_demo.sh
```

## Features

![Core modules](assets/readme/core-modules.png)

| Module | Purpose |
| --- | --- |
| Workflow Builder | 문서 입력, 분류, 분기, 추출, 필수 항목 확인, 병합, export 노드를 연결합니다. |
| Document Classifier | 사용자가 정의한 class 후보와 `unknown` 기준으로 문서를 분류합니다. |
| Required Field Checker | 성명, 날짜, 서명, 체크박스 등 필수 항목의 존재 여부를 확인합니다. |
| Key Information Extractor | 저장된 schema 기준으로 field, value, confidence, evidence를 추출합니다. |
| Raw Data Extractor | PDF, Office 문서, 이미지의 preview와 원문 데이터를 생성합니다. |

## Workflow Builder

![Workflow Builder](assets/readme/workflow-builder.png)

![Workflow Builder result view](assets/readme/workflow-builder-results.png)

- React Flow 캔버스에서 문서 처리 모듈을 연결합니다.
- 업로드한 문서를 workflow run으로 처리합니다.
- 분류 결과에 따라 class별 schema/checklist 경로를 나눌 수 있습니다.
- 실행 상태는 캔버스 위 progress로 표시하고, 결과는 overlay에서 문서 이미지와 함께 검수합니다.
- 결과는 CSV 또는 JSON으로 export합니다.

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | Vite, React, TypeScript, React Flow |
| Backend | FastAPI, SQLAlchemy, Alembic |
| Storage | Local filesystem, S3-compatible adapter 준비 |
| Document Preview | PyMuPDF, LibreOffice headless |
| VLM | Gemini/OpenAI-compatible/mock provider |

## Input / Output

| Input | Handling |
| --- | --- |
| PDF | page image로 rasterize 후 preview와 VLM context에 사용 |
| PNG/JPG/JPEG | 단일 page document로 저장 |
| DOCX/PPTX | LibreOffice로 PDF 변환 후 처리 |
| XLSX | sheet HTML과 PDF preview 생성 |

| Output | Format |
| --- | --- |
| KIE | field, value, normalized value, confidence, evidence |
| Classification | class name, confidence, reason, evidence |
| Required Check | item별 present/missing/uncertain/not_applicable |
| Workflow Export | branch별 union-column CSV/JSON |

## Local Run

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'

cd frontend
npm ci
cd ..

./scripts/run_dev.sh
```

| Server | URL |
| --- | --- |
| Frontend | `http://127.0.0.1:5173` |
| Backend | `http://127.0.0.1:8000` |

Mock VLM으로 UI와 workflow만 확인할 때:

```env
VLM_PROVIDER=mock
VLM_MODEL_NAME=mock-vlm
```

## Production Hosting

기본 배포 방식은 frontend 정적 호스팅과 backend API 분리 배포입니다. 단일 서버 fallback도 지원합니다.

| Env | Description |
| --- | --- |
| `APP_ENV=production` | production mode |
| `ACCESS_CONTROL_MODE=shared_secret` | 공유 접근 코드 기반 접근 제어 |
| `APP_ACCESS_SECRET` | 외부 접근 코드 |
| `SESSION_SECRET_KEY` | HttpOnly session cookie 서명 키 |
| `CORS_ALLOWED_ORIGINS` | frontend origin allowlist |
| `DATABASE_URL` | SQLite 또는 Postgres URL |
| `STORAGE_BACKEND=local` | local persistent volume 저장 |
| `UPLOAD_MAX_BATCH_FILES=10000` | 한 번에 업로드할 수 있는 batch 파일 수 |
| `UPLOAD_RETENTION_HOURS=24` | 업로드 문서 하루 단위 삭제 |
| `SERVE_FRONTEND=true` | FastAPI가 `frontend/dist`를 직접 서빙 |

```bash
cd frontend
npm run build

APP_ENV=production \
ACCESS_CONTROL_MODE=shared_secret \
APP_ACCESS_SECRET=<shared-code> \
SESSION_SECRET_KEY=<session-secret> \
DATABASE_URL=sqlite:////data/document-automation.db \
DOCUMENT_STORAGE_DIR=/data/documents \
RAW_STORAGE_DIR=/data/raw \
PROCESSING_TMP_DIR=/data/processing \
UPLOAD_RETENTION_HOURS=24 \
SERVE_FRONTEND=true \
FRONTEND_DIST_DIR="$(pwd)/dist" \
../.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --host 0.0.0.0 --port 8000
```

세부 배포 절차는 [docs/deployment.md](docs/deployment.md)에 정리되어 있습니다.

## Design

UI는 Toss Design System을 참고하여 회색 기반 표면, 파란색 primary action, list 중심 정보 구조로 정리했습니다.

## Test

```bash
npm run build --prefix frontend
.venv/bin/python -m pytest backend -q
```

## Repository

```text
backend/      FastAPI API, document processing, workflow execution
frontend/     React application
scripts/      local run and hosting demo scripts
docs/         deployment notes
assets/       README images
```
