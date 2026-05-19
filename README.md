# KIE MVP

KIE(Key Information Extractor) MVP는 PDF/이미지 문서를 업로드하고 사용자가 정의하거나 AI가 추천한 schema에 맞춰 VLM으로 key information을 추출하는 React + FastAPI 애플리케이션입니다.

`key_name`은 UI와 export에 그대로 쓰이는 최종 필드명입니다. AI 추천 Schema는 문서의 주 언어를 보고 한국어 문서에는 `성명`, `계급`, `소집기간` 같은 한국어 key를, 영어 문서에는 `invoice_number`, `total_amount` 같은 concise English key를 추천합니다. field-level `display_name`은 사용하지 않습니다.

## Current Features

- PDF, PNG, JPG, JPEG 업로드 및 페이지 이미지 미리보기
- 문서 뷰어: 썸네일, page 이동, fit width, fit page, zoom, rotate
- Provider status: mock/openai mode, model name, credential 상태 표시
- AI 추천 Schema: 문서 유형, 언어, 요약/추천 reasoning과 함께 schema draft 생성
- Schema builder: 수동 작성, JSON import/export, sample, 저장, 수정 시 version 증가
- Template library: saved schema를 template/pinned/category metadata로 재사용
- History/archive: 최근 문서/schema/job, SQLite LIKE 기반 archive search, workspace resume
- Batch workspace: schema 선택 후 여러 문서 업로드 및 문서별 job 생성/progress 표시
- VLM extraction structured output: value, normalized_value, page, confidence, evidence, warnings
- Review UX: needs review 중심 필터, warning/null/low confidence/edited/unreviewed 필터, reviewed progress
- Export preset: field 포함/제외, 순서, 컬럼명, format 저장 후 JSON/CSV export
- Audit log: upload, recommendation, schema save/update, extraction, review save, export, batch event 기록
- `VLM_PROVIDER=mock` demo mode

## Structure

```text
.
├── backend/                 # FastAPI, SQLite, document processing, VLM extraction
├── frontend/                # Vite + React + TypeScript UI
├── KIE_development_definition.md
├── ERROR_NOTE.md
├── .env.example
└── README.md
```

## Environment

이 프로젝트는 conda를 사용하지 않습니다. `uv`로 Python 3.11 `.venv`를 만듭니다.

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'
```

Backend는 root `.env`를 읽습니다. 실제 secret은 `.env.example`에 넣지 않습니다.

```env
APP_ENV=local
VLM_PROVIDER=openai
VLM_API_KEY=
VLM_MODEL_NAME=
VLM_BASE_URL=
VLM_TEMPERATURE=0
VLM_MAX_RETRIES=2
VLM_TIMEOUT_SECONDS=120

# Existing aliases are also supported:
OPENAI_API_KEY=
OPENAI_MODEL_NAME=
```

API key 없이 전체 demo flow를 확인하려면 mock mode를 사용합니다.

```env
VLM_PROVIDER=mock
```

React에는 secret을 넣지 않습니다.

```bash
cp frontend/.env.example frontend/.env
```

## Backend

```bash
VLM_PROVIDER=mock .venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

OpenAI compatible VLM을 사용할 때:

```bash
VLM_PROVIDER=openai .venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

주요 API:

- `GET /api/health`
- `GET /api/system/status`
- `POST /api/documents`
- `GET /api/documents?limit=20`
- `GET /api/documents/{document_id}`
- `GET /api/documents/{document_id}/pages/{page_number}/image`
- `POST /api/schemas`
- `GET /api/schemas`
- `GET /api/schemas?templates=true`
- `GET /api/schemas/{schema_id}`
- `PATCH /api/schemas/{schema_id}`
- `POST /api/schemas/recommendations`
- `POST /api/extraction-jobs`
- `GET /api/extraction-jobs?limit=20&document_id=...`
- `GET /api/extraction-jobs/{job_id}`
- `PATCH /api/extraction-results/{result_id}`
- `GET /api/extraction-results/{result_id}/export?format=json|csv&preset_id=...`
- `POST /api/batches`
- `GET /api/batches`
- `GET /api/batches/{batch_id}`
- `GET /api/archive/search?q=&status=&schema_id=&document_type=&limit=`
- `POST /api/export-presets`
- `GET /api/export-presets?schema_id=...`
- `PATCH /api/export-presets/{id}`
- `DELETE /api/export-presets/{id}`
- `GET /api/audit-events?entity_type=&entity_id=&limit=`

## Frontend

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev -- --host 127.0.0.1 --port 5173
```

기본 URL은 `http://127.0.0.1:5173`입니다.

UI 흐름:

1. Upload: PDF, PNG, JPG, JPEG 업로드
2. Provider 확인: 상단 pill에서 `Mock mode` 또는 `OpenAI mode`, model, credential 상태 확인
3. AI recommend schema: 문서 인식 카드와 schema draft 생성
4. Save schema: 추천/수정 draft 저장, 필요하면 template로 pin/category 지정
5. Extract: 저장된 schema로 extraction job 생성
6. Review: needs review, warning, null, low confidence, edited, unreviewed 필터와 reviewed checkbox로 검토
7. Export: preset 저장 후 JSON/CSV export
8. Archive/Batch: 기존 workspace resume 또는 다중 문서 batch 생성

AI 추천 Schema는 업로드 후 사용자가 `AI recommend schema` 버튼을 눌렀을 때만 실행됩니다. 추천 결과는 DB에 schema로 자동 저장되지 않고 UI draft에 반영되며, 사용자가 `Save schema`를 눌러야 저장됩니다. 추천 과정에서 문서 row에는 `document_type`, `language`, `ai_summary`, `recommendation_reasoning`이 저장됩니다.

한국어 문서 추천 예시:

```json
{
  "key_name": "소집기간",
  "description": "소집통지서의 소집기간 표에 표시된 훈련 날짜와 시간",
  "output_format": "string"
}
```

## Run Both Servers

루트에서 backend와 frontend를 한 번에 실행할 수 있습니다.

```bash
./scripts/run_dev.sh
```

기본값:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:5173`

포트를 바꾸려면 환경변수를 지정합니다.

```bash
BACKEND_PORT=8010 FRONTEND_PORT=5174 ./scripts/run_dev.sh
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

권장 smoke test:

1. `VLM_PROVIDER=mock`로 backend 실행
2. frontend 실행
3. 문서 업로드
4. Provider pill이 mock/openai 상태를 정확히 보여주는지 확인
5. AI 추천 Schema 실행 및 diff/apply 동작 확인
6. schema 저장
7. extraction 실행
8. needs review 필터, reviewed progress, page/evidence/confidence 확인
9. 수정 저장
10. export preset 저장 및 JSON/CSV export 확인
11. archive search에서 결과 클릭 후 workspace resume 확인
12. template 선택 및 batch upload flow 확인

## VLM Output Shape

Extraction 결과는 필드별로 다음 구조를 사용합니다.

```json
{
  "values": {
    "invoice_number": {
      "value": "INV-001",
      "normalized_value": "INV-001",
      "page": 1,
      "confidence": 0.92,
      "evidence": "Invoice No. INV-001",
      "warnings": []
    }
  }
}
```

기존 primitive 응답도 backend validation layer에서 호환합니다.

Schema recommendation 결과는 기존 schema draft에 다음 문서 인식 값을 추가로 포함합니다.

```json
{
  "name": "ai_recommended_schema",
  "display_name": "AI Recommended Schema",
  "description": "Recommended fields for this document.",
  "document_type": "소집통지서",
  "language": "ko",
  "reasoning": "문서 제목과 표 구조상 병역/예비군 소집통지서로 판단됩니다.",
  "fields": [
    {
      "key_name": "성명",
      "description": "상단 인적사항 표의 성명 칸에 적힌 이름",
      "output_format": "string"
    }
  ]
}
```

## Notes

- SQLite DB는 기본적으로 `backend/kie.db`에 생성됩니다.
- 새 컬럼은 `init_db()`에서 lightweight migration으로 추가하므로 기존 local DB 데이터를 유지합니다.
- 업로드 문서와 페이지 이미지는 `backend/storage/`에 저장됩니다.
- 인증이 없는 MVP이므로 히스토리, archive, audit log는 로컬 SQLite 전체 데이터를 보여줍니다.
- 운영용 queue worker, 사용자/권한, PostgreSQL 전환, bbox 하이라이트는 이번 범위에서 제외했습니다.
