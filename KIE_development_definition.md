# KIE(Key Information Extractor) 개발정의서

문서 목적: 사용자가 업로드한 문서 이미지에서 직접 정의하거나 AI가 추천한 schema에 해당하는 값만 VLM으로 추출하는 KIE MVP의 제품 범위, UX, 아키텍처, API, 데이터 모델, 검증 기준을 정의한다.

## 1. 프로젝트 개요

KIE MVP는 PDF/이미지 문서를 업로드하고, 사용자가 정의한 필드 단위 schema를 기준으로 VLM이 key information을 추출하는 업무형 도구이다. 이번 범위는 “데모 도구” 느낌을 줄이고 실제 서비스처럼 상태 인지, 작업 재개, 템플릿, 배치, 검색, 검토 진행률, export preset, audit log를 제공하는 것을 목표로 한다.

핵심 전제:

- `key_name`은 최종 JSON key이자 UI/export 표시명이다.
- field-level `display_name`은 사용하지 않는다.
- AI 추천 Schema는 문서 주 언어를 보고 `key_name` 언어를 선택한다. 한국어 문서라면 `성명`, `계급`, `소집기간` 같은 한국어 key를 사용하고, 영어 문서라면 `invoice_number`, `total_amount` 같은 concise English key를 사용한다.
- schema 자체의 `display_name`은 기존 API 호환을 위해 유지한다.
- `description`은 문서 전체 설명이 아니라 각 필드 값을 어디서/어떻게 찾을지 알려주는 필드 단위 지시문이다.
- VLM API key와 model name은 backend `.env`에서만 관리한다.
- React frontend에는 secret을 전달하지 않는다.
- 인증, 사용자 권한, PostgreSQL 전환, 운영용 queue worker, bbox 하이라이트는 MVP 범위에서 제외한다.

## 2. MVP 범위

포함 기능:

- PDF, PNG, JPG, JPEG 업로드
- 페이지 이미지 생성 및 문서 뷰어
- 페이지 썸네일, 이전/다음 페이지, fit width, fit page, zoom, rotate
- Provider status: `Mock mode`, `OpenAI mode`, model name, credential 상태
- 수동 schema builder
- AI 추천 Schema와 문서 인식 카드
- 추천 schema diff/apply UX
- sample schema 적용
- schema JSON import/export
- schema 저장 및 기존 schema 수정 시 version 증가
- template library: 기존 schema에 `is_template`, `template_category`, `pinned` metadata 부여
- 최근 문서/schema/extraction job 히스토리
- workspace resume: 문서 클릭 시 최신 job/schema/result 복원
- batch upload: schema 선택 후 여러 파일 업로드, 문서별 job 생성 및 progress 표시
- archive/search: 문서명, schema명, job 상태, 추출 key/value LIKE 검색
- VLM structured output extraction
- `VLM_PROVIDER=mock` demo mode
- review progress, reviewed checkbox, 수정 저장
- needs review, warning, null, low confidence, edited, unreviewed 필터
- page/evidence/confidence 표시
- export preset 저장 및 JSON/CSV export
- audit log 저장 및 조회

제외 기능:

- 사용자 계정 및 권한
- PostgreSQL migration 체계
- 운영용 queue worker
- bbox 기반 하이라이트
- 비용/latency dashboard
- OCR 텍스트 병합 입력

## 3. UX 정의

### 3.1 전체 흐름

1. 사용자가 문서를 업로드한다.
2. backend가 원본 파일을 저장하고 페이지 이미지를 만든다.
3. 상단 provider pill에서 mock/openai, model, credential 상태를 확인한다.
4. 사용자가 schema를 직접 작성하거나 AI 추천 Schema를 실행한다.
5. AI 추천 결과는 document intelligence card와 schema draft로 표시된다.
6. 기존 draft가 비어 있으면 추천 결과를 바로 적용한다.
7. 기존 draft가 있거나 dirty 상태이면 diff modal에서 added/removed/changed `key_name`을 확인하고 적용한다.
8. 추천 Schema는 자동 저장되지 않고 UI draft에만 반영된다.
9. 사용자가 schema를 저장한다.
10. 사용자가 extraction을 실행한다.
11. backend가 VLM structured output을 실행하고 validation/normalization을 적용한다.
12. 사용자가 needs review 중심으로 결과를 검토하고 reviewed checkbox를 저장한다.
13. 사용자가 export preset을 선택하거나 저장한 뒤 JSON/CSV로 export한다.
14. 이후 archive/history에서 문서 workspace를 resume할 수 있다.

### 3.2 Upload/History/Archive

- 좌측은 업로드 drop zone 또는 문서 뷰어이다.
- 우측에는 archive search, 최근 문서/schema/job 히스토리, schema 작업 영역이 있다.
- archive search는 검색어, status, schema, document type filter를 제공한다.
- archive 결과 클릭 시 문서, 최신 job, schema, result를 함께 복원한다.

### 3.3 Schema 화면

- 좌측은 문서 뷰어이다.
- 우측은 schema builder이다.
- 사용자는 다음 방식으로 schema를 만들 수 있다.
  - 직접 필드 추가
  - AI 추천 Schema
  - template 선택
  - 최근 schema 불러오기
  - sample schema 적용
  - JSON import
- schema 필드는 `key_name`, `description`, `output_format`을 필수로 가진다.
- AI 추천 후 `document_type`, `language`, `reasoning`, page count를 보여준다.
- 기존 schema를 불러와 수정 후 저장하면 같은 schema의 새 version이 생성된다.
- saved schema는 template/pinned/category metadata를 가질 수 있다.

### 3.4 Batch 화면

- batch는 schema/template을 먼저 선택한 뒤 여러 파일을 업로드하는 흐름이다.
- backend는 문서별 `Document`와 `ExtractionJob`을 생성한다.
- frontend는 batch status, progress, 문서별 job/result/error를 표시한다.
- batch item을 클릭하면 해당 문서 workspace로 resume한다.

### 3.5 Review 화면

- 추출 결과는 key별 row로 표시한다.
- 각 row는 reviewed checkbox, `value`, `page`, `confidence`, `warnings`, `evidence`를 보여준다.
- page 값 클릭 시 문서 뷰어가 해당 페이지로 이동한다.
- 수정 시 original/edited 비교를 보여준다.
- 진행률은 `reviewed / total` 형식으로 표시한다.
- 필터:
  - `needs_review`: warning, null, low confidence, unreviewed 중심
  - `all`: 전체
  - `warning`: warning이 있는 필드
  - `null`: 값이 비어 있는 필드
  - `low_confidence`: confidence가 낮은 필드
  - `changed`: 사용자가 수정한 필드
  - `unreviewed`: reviewed 체크가 없는 필드

### 3.6 Audit Log

- document/job/schema detail 하단에 최근 audit event를 표시한다.
- 실패 이벤트는 error message를 함께 저장한다.
- 이벤트 대상은 `document`, `schema`, `job`, `result`, `batch`, `export_preset`이다.

## 4. 시스템 아키텍처

구성 요소:

- Frontend: Vite + React + TypeScript
- Backend API: FastAPI
- DB: SQLite
- File storage: local filesystem
- PDF/image processing: PyMuPDF
- VLM orchestration: LangChain + OpenAI compatible chat model
- Background work: FastAPI BackgroundTasks

환경변수:

```env
APP_ENV=local
DATABASE_URL=
DOCUMENT_STORAGE_DIR=

VLM_PROVIDER=openai
VLM_API_KEY=
VLM_MODEL_NAME=
VLM_BASE_URL=
VLM_TEMPERATURE=0
VLM_MAX_RETRIES=2
VLM_TIMEOUT_SECONDS=120

OPENAI_API_KEY=
OPENAI_MODEL_NAME=
```

`VLM_PROVIDER=mock`이면 API key 없이 deterministic mock schema recommendation과 mock extraction을 실행한다.

Frontend:

```env
VITE_API_BASE_URL=http://localhost:8000
```

## 5. 처리 플로우

### 5.1 문서 업로드

1. 사용자가 파일을 업로드한다.
2. backend가 확장자를 검증한다.
3. 원본 파일을 `backend/storage/documents/{uuid}/original.*`에 저장한다.
4. PDF는 페이지별 PNG로 변환한다.
5. 이미지 파일은 단일 페이지 PNG로 저장한다.
6. `documents`, `document_pages`에 metadata를 저장한다.
7. `upload` audit event를 기록한다.
8. frontend는 `image_url`로 페이지를 렌더링한다.

### 5.2 AI 추천 Schema

1. 사용자가 업로드 후 `AI recommend schema` 버튼을 누른다.
2. frontend가 `POST /api/schemas/recommendations`에 `document_id`를 보낸다.
3. backend가 문서 페이지 이미지를 VLM에 전달한다.
4. VLM은 추천 schema draft와 `document_type`, `language`, `reasoning`을 반환한다.
5. 추천 field의 `key_name`은 문서 주 언어에 맞춰 생성한다.
6. backend는 추천 schema를 Pydantic schema로 검증하고 중복 key를 제거한다.
7. backend는 document row에 `document_type`, `language`, `ai_summary`, `recommendation_reasoning`을 저장한다.
8. `schema_recommendation` audit event를 기록한다.
9. frontend는 추천 결과를 UI draft에 반영한다.
10. 추천 결과는 사용자가 저장하기 전까지 schema table에 저장되지 않는다.

### 5.3 Schema 저장/수정/Template

신규 저장:

- `POST /api/schemas`
- `schemas.current_version = 1`
- `schema_versions.version = 1`
- `schema_save` audit event 기록

기존 schema 수정:

- `PATCH /api/schemas/{schema_id}`
- `schemas.current_version += 1`
- 새 `schema_versions` row 생성
- `schema_update` audit event 기록
- extraction job은 실행 당시 `schema_version`을 계속 참조한다.

Template:

- `schemas.is_template`, `schemas.template_category`, `schemas.pinned`를 사용한다.
- 별도 template table은 만들지 않는다.

### 5.4 Extraction

1. frontend가 저장된 `schema_id`, `schema_version`, `document_id`로 extraction job을 생성한다.
2. backend가 job을 `queued`로 저장하고 `extraction_create` audit event를 기록한다.
3. BackgroundTasks가 job을 실행한다.
4. schema fields와 page images를 VLM에 전달한다.
5. raw model output을 validation layer가 표준 형태로 변환한다.
6. 결과를 `extraction_results`에 저장한다.
7. job 상태를 `completed`, `needs_review`, `failed` 중 하나로 변경한다.
8. 성공/실패 event를 audit log에 기록한다.

### 5.5 Review/Export

1. frontend가 job 결과를 표시한다.
2. 사용자는 값을 수정하고 reviewed checkbox를 저장할 수 있다.
3. 수정값은 `corrected_output`에 저장한다.
4. reviewed 상태는 `reviewed_fields` JSON에 저장한다.
5. export 시 `corrected_output`이 있으면 우선 사용한다.
6. export preset이 있으면 field 순서, 포함/제외, 컬럼명을 적용한다.
7. JSON export는 전체 구조를 반환한다.
8. CSV export는 preset이 없을 때 `key_name`, `value`, `normalized_value`, `page`, `confidence`, `evidence`, `warnings`를 포함한다.
9. `review_save`와 `export` audit event를 기록한다.

### 5.6 Batch

1. 사용자가 schema/template을 선택한다.
2. 여러 파일을 `POST /api/batches`로 업로드한다.
3. backend가 batch row를 만들고 파일별 document/job/batch item을 생성한다.
4. 각 extraction job은 BackgroundTasks로 실행된다.
5. batch 조회 API는 전체 progress와 item status를 계산해 반환한다.
6. `batch_create` audit event를 기록한다.

## 6. 데이터 모델

### 6.1 SchemaDefinition

```json
{
  "id": "schema_001",
  "name": "소집통지서_schema",
  "display_name": "소집통지서 Schema",
  "description": "예비군 소집통지서에서 필요한 핵심 필드",
  "current_version": 2,
  "is_template": true,
  "template_category": "military",
  "pinned": true,
  "fields": [
    {
      "key_name": "소집기간",
      "description": "소집통지서의 소집기간 표에 표시된 훈련 날짜와 시간",
      "output_format": "string"
    }
  ]
}
```

### 6.2 FieldDefinition

- `key_name`: 최종 JSON key이자 UI 표시명. 문서 주 언어에 맞춰 추천한다.
- `description`: 해당 값을 문서에서 찾는 기준
- `output_format`: `string`, `float`, `date`, `bool`

### 6.3 Document Intelligence

```json
{
  "document_type": "예비군 소집통지서",
  "language": "ko",
  "ai_summary": "예비군 교육훈련 소집 대상자와 훈련 일정이 적힌 통지서",
  "recommendation_reasoning": "제목, 인적사항 표, 소집기간 표가 있어 소집통지서로 판단됩니다."
}
```

### 6.4 ExtractionValue

```json
{
  "value": "2026.05.19",
  "normalized_value": "2026-05-19",
  "page": 1,
  "confidence": 0.91,
  "evidence": "Issued Date: 2026.05.19",
  "warnings": []
}
```

Validation/normalization:

- `date`: `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY년 M월 D일`을 `YYYY-MM-DD`로 정규화
- `float`: 통화 기호, 공백, 쉼표 제거 후 float 변환
- `bool`: `true/false`, `yes/no`, `y/n`, `1/0`, `예/아니오`, `동의/미동의` 처리
- 기존 primitive VLM 응답도 표준 `ExtractionValue` 형태로 감싼다.

### 6.5 ExportPreset

```json
{
  "name": "default_review_export",
  "schema_id": "schema_001",
  "format": "csv",
  "fields": [
    {
      "key_name": "소집기간",
      "column_name": "소집기간",
      "included": true,
      "order": 1
    }
  ]
}
```

## 7. API 정의

### System

```http
GET /api/health
GET /api/system/status
```

`GET /api/system/status`는 `vlm_provider`, `vlm_model_name`, `has_vlm_credentials`, `is_mock`, `app_env`를 반환한다. secret 값은 반환하지 않는다.

### Documents

```http
POST /api/documents
GET /api/documents?limit=20
GET /api/documents/{document_id}
GET /api/documents/{document_id}/pages/{page_number}/image
```

### Schemas

```http
POST /api/schemas
GET /api/schemas
GET /api/schemas?templates=true
GET /api/schemas/{schema_id}
PATCH /api/schemas/{schema_id}
POST /api/schemas/recommendations
```

AI 추천 요청:

```json
{
  "document_id": "doc_001"
}
```

AI 추천 응답:

```json
{
  "name": "ai_recommended_schema",
  "display_name": "AI Recommended Schema",
  "description": "Recommended fields for this document.",
  "document_type": "예비군 소집통지서",
  "language": "ko",
  "reasoning": "문서 제목과 표 구조상 예비군 교육훈련 소집통지서로 판단됩니다.",
  "fields": [
    {
      "key_name": "소집기간",
      "description": "소집통지서의 소집기간 표에 표시된 훈련 날짜와 시간",
      "output_format": "string"
    }
  ]
}
```

### Extraction Jobs/Results

```http
POST /api/extraction-jobs
GET /api/extraction-jobs?limit=20&document_id=doc_001
GET /api/extraction-jobs/{job_id}
PATCH /api/extraction-results/{result_id}
GET /api/extraction-results/{result_id}/export?format=json
GET /api/extraction-results/{result_id}/export?format=csv
GET /api/extraction-results/{result_id}/export?format=csv&preset_id=preset_001
```

Review patch:

```json
{
  "corrected_output": {
    "values": {
      "소집기간": {
        "value": "2026년 5월 19일",
        "normalized_value": "2026-05-19",
        "page": 1,
        "confidence": 0.88,
        "evidence": "소집기간 2026년 5월 19일",
        "warnings": []
      }
    }
  },
  "reviewed_fields": {
    "소집기간": true
  }
}
```

### Batches

```http
POST /api/batches
GET /api/batches
GET /api/batches/{batch_id}
```

`POST /api/batches`는 multipart form으로 `schema_id`, optional `schema_version`, `files[]`를 받는다.

### Archive/Search

```http
GET /api/archive/search?q=&status=&schema_id=&document_type=&limit=
```

검색 대상:

- 문서명
- schema명/display name
- job status
- document_type/language
- extracted key/value/evidence

### Export Presets

```http
POST /api/export-presets
GET /api/export-presets?schema_id=schema_001
PATCH /api/export-presets/{id}
DELETE /api/export-presets/{id}
```

### Audit Events

```http
GET /api/audit-events?entity_type=&entity_id=&limit=
```

## 8. DB 테이블

### documents

- id
- filename
- mime_type
- size_bytes
- page_count
- storage_path
- status
- document_type
- language
- ai_summary
- recommendation_reasoning
- created_at

### document_pages

- id
- document_id
- page_number
- image_path
- width
- height
- created_at

### schemas

- id
- name
- display_name
- description
- current_version
- is_template
- template_category
- pinned
- created_at
- updated_at

### schema_versions

- id
- schema_id
- version
- schema_json
- created_at

### extraction_jobs

- id
- document_id
- schema_id
- schema_version
- status
- error_message
- result_id
- started_at
- completed_at
- created_at

### extraction_results

- id
- job_id
- raw_model_output
- validated_output
- corrected_output
- reviewed_fields
- validation_warnings
- created_at
- updated_at

### batches / batch_items

- batches: id, schema_id, schema_version, status, total_count, completed_count, failed_count, created_at, updated_at
- batch_items: id, batch_id, document_id, job_id, status, error_message, created_at, updated_at

### export_presets

- id
- schema_id
- name
- format
- fields_json
- created_at
- updated_at

### audit_events

- id
- entity_type
- entity_id
- action
- message
- metadata_json
- created_at

## 9. VLM 프롬프트 원칙

Extraction:

- schema에 정의된 key만 반환한다.
- 값이 보이지 않거나 불확실하면 `null`을 반환한다.
- 가능하면 원문 wording을 `value`에 보존한다.
- `page`, `evidence`, `confidence`를 함께 제공한다.

Schema recommendation:

- 문서 이미지에서 실제로 보이는 비즈니스 핵심 필드를 우선한다.
- `key_name`은 문서 주 언어에 맞춰 만든다.
- 한국어 문서에서는 자연스러운 한국어 key를 사용한다.
- 영어 문서에서는 concise English key를 사용한다.
- 문서가 혼합 언어이면 사용자가 업무상 식별하기 쉬운 주 언어를 선택한다.
- field-level `display_name`은 만들지 않는다.
- `description`은 필드 단위 위치/판단 기준을 담는다.
- 지원 format은 `string`, `float`, `date`, `bool`만 사용한다.
- top-level `document_type`, `language`, `reasoning`을 반환한다.

## 10. 오류 처리

- 지원하지 않는 파일 형식: 400
- 문서/schema/job/result 미존재: 404
- schema validation 실패: 422
- VLM credential 누락: 400
- VLM 추천 schema 형식 오류: 502
- extraction 실패: job 상태 `failed`, `error_message` 저장, audit event 기록
- batch item 실패: item `status=failed`, `error_message` 저장

Frontend는 VLM credential 누락과 mock mode를 사용자가 조치할 수 있는 문장으로 표시한다.

## 11. 테스트 및 검증 기준

Backend:

- health/system status
- upload image/PDF
- document list/get
- schema create/list/get/update
- template metadata update/list/filter
- AI schema recommendation mock
- document intelligence 저장
- extraction failure without credentials
- extraction mock success
- result correction 및 reviewed_fields 저장
- export preset create/list/update/delete
- preset 적용 JSON/CSV export
- batch upload와 progress 계산
- archive search
- audit event 생성 및 조회
- 기존 upload/schema/extraction/export 회귀 테스트

Frontend:

- `npm run build`
- desktop Playwright flow: upload, provider status, AI recommend, diff/apply, save schema, extract, needs review, reviewed checkbox, export preset
- batch flow: template/schema 선택, 다중 파일 업로드, batch progress, 개별 job resume
- archive flow: 검색, 결과 클릭, workspace resume
- mobile viewport: topbar, CTA, document card, review table, batch/archive panels가 겹치지 않음

## 12. MVP 수용 기준

- 사용자가 PDF 또는 이미지 문서를 업로드할 수 있다.
- provider 상태가 mock/openai, model, credential 상태를 secret 없이 보여준다.
- 사용자가 최소 5개 이상의 필드를 가진 schema를 만들 수 있다.
- AI 추천 Schema가 업로드 문서를 보고 draft schema를 생성할 수 있다.
- AI 추천 Schema는 문서 주 언어에 맞는 `key_name`을 생성한다.
- AI 추천 Schema는 `document_type`, `language`, `reasoning`을 반환하고 문서 row에 저장한다.
- 추천 Schema는 자동 저장되지 않는다.
- 기존 schema 수정 시 version이 증가한다.
- schema를 template/pinned/category로 관리할 수 있다.
- 업로드 문서와 schema를 사용해 extraction을 실행할 수 있다.
- batch upload가 여러 문서별 job을 생성하고 progress를 표시한다.
- archive search에서 문서/job/schema/result를 찾고 workspace resume할 수 있다.
- 결과는 schema에 정의된 필드만 포함한다.
- 결과는 `value`, `normalized_value`, `page`, `confidence`, `evidence`, `warnings`를 포함한다.
- 사용자는 needs review/warning/null/low confidence/edited/unreviewed 기준으로 결과를 검토할 수 있다.
- 사용자는 reviewed progress를 저장하고 다시 조회할 수 있다.
- 사용자는 결과를 수정하고 저장할 수 있다.
- 사용자는 export preset을 저장하고 JSON/CSV export에 적용할 수 있다.
- 주요 작업은 audit log에 기록된다.
- `VLM_PROVIDER=mock`으로 API key 없이 demo flow를 확인할 수 있다.

## 13. 주요 리스크

- 필드 설명이 부실하면 모델이 잘못된 값을 선택할 수 있다.
- 문서 해상도나 스캔 품질이 낮으면 추출 정확도가 떨어진다.
- 표나 반복 항목은 일반 필드보다 추출 난도가 높다.
- structured output은 형식 안정성에는 강하지만 의미적 정답성을 보장하지 않는다.
- 외부 VLM API 사용 시 비용과 개인정보 이슈가 발생한다.
- 인증 없는 MVP 히스토리/archive/audit log는 로컬 전체 데이터를 보여주므로 다중 사용자 환경에는 적합하지 않다.
- SQLite lightweight migration은 MVP에는 충분하지만 운영 배포에는 Alembic 같은 migration 체계가 필요하다.

## 14. 후속 개발 후보

- bbox evidence와 하이라이트
- OCR 텍스트 병합
- schema 평가 데이터셋
- 운영 queue worker
- 사용자/권한
- PostgreSQL 및 Alembic migration 도입
- 비용/latency monitoring
- 권한 기반 audit log filtering
