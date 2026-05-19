# Digitize Your Document 개발정의서

문서 목적: `Digitize Your Document`의 현재 MVP 범위, UX, API, 데이터 처리 방식, 검증 기준을 정의한다.

## 1. 제품 개요

Digitize Your Document는 다양한 문서를 디지털 정보로 변환하는 React + FastAPI 워크스페이스이다.

현재 구현 기능:

- **Raw Data Extractor**: Office/PDF 문서를 PDF preview와 HTML 정보 추출 결과로 변환
- **KIE(Key Information Extractor)**: 사용자가 정의한 schema 기준으로 문서 이미지에서 key information 추출

예정 기능:

- **OCR**: 이미지/PDF에 대한 단순 OCR
- **Intelligence Parse**: 문서를 지능적으로 구조화/파싱

핵심 원칙:

- Python 친화적인 라이브러리와 로컬 처리 흐름을 우선한다.
- VLM secret은 backend `.env`에서만 관리한다.
- React frontend에는 secret을 전달하지 않는다.
- OCR/Intelligence Parse는 이번 범위에서 disabled 기능 카드로만 표시한다.

## 2. Raw Data Extractor

### 2.1 UX

1. 사용자가 홈 화면에서 Raw Data Extractor를 선택한다.
2. `.docx`, `.xlsx`, `.pptx`, `.pdf` 파일을 업로드한다.
3. backend가 원본 파일을 저장한다.
4. backend가 LibreOffice로 PDF preview를 생성한다. PDF 입력은 그대로 복사한다.
5. backend가 포맷별 Python parser로 HTML 정보를 생성한다.
6. frontend 좌측은 PDF preview iframe, 우측은 HTML preview iframe을 보여준다.
7. 사용자는 최근 raw extraction 목록에서 이전 결과를 다시 열 수 있다.

### 2.2 API

```http
POST /api/raw-extractions
GET /api/raw-extractions?limit=20
GET /api/raw-extractions/{id}
GET /api/raw-extractions/{id}/pdf
GET /api/raw-extractions/{id}/html
```

응답 구조:

```json
{
  "id": "raw_xxx",
  "filename": "sample.docx",
  "source_format": "docx",
  "size_bytes": 12345,
  "status": "completed",
  "pdf_url": "/api/raw-extractions/raw_xxx/pdf",
  "html_url": "/api/raw-extractions/raw_xxx/html",
  "warnings": [],
  "error_message": null,
  "created_at": "2026-05-20T00:00:00",
  "updated_at": "2026-05-20T00:00:00"
}
```

### 2.3 저장 구조

```text
backend/storage/raw/{raw_id}/original.ext
backend/storage/raw/{raw_id}/preview.pdf
backend/storage/raw/{raw_id}/content.html
```

### 2.4 파싱 전략

- `.docx`: `mammoth`로 semantic HTML 생성 후 `bleach`로 sanitize
- `.xlsx`: `openpyxl` read-only 모드로 sheet별 HTML table 생성
- `.pptx`: `python-pptx`로 slide text/table을 section 단위 HTML로 생성
- `.pdf`: PyMuPDF로 page text block을 HTML section으로 생성

### 2.5 PDF 변환

LibreOffice headless 변환을 사용한다. 변환 구조는 `sync_raw_to_pdf.py`의 OS별 LibreOffice 경로 탐색, 임시 디렉터리 변환, 결과 PDF 이동 패턴을 참고한다.

필터:

- `.docx`: `writer_pdf_Export`
- `.xlsx`: `calc_pdf_Export`
- `.pptx`: `impress_pdf_Export`
- `.pdf`: 변환 없이 복사

LibreOffice가 없거나 변환에 실패하면 row는 `status=failed`로 저장하고 `error_message`를 반환한다.

## 3. KIE

KIE는 기존 기능으로 유지한다.

기능:

- PDF/PNG/JPG/JPEG 업로드 및 페이지 이미지 미리보기
- schema builder: `key_name`, `description`, `output_format`
- output format: `string`, `float`, `date`, `bool`
- VLM structured output 기반 extraction
- 결과 review, correction, JSON/CSV export

주요 API:

```http
GET /api/system/status
POST /api/documents
GET /api/documents
POST /api/schemas
GET /api/schemas
PATCH /api/schemas/{schema_id}
POST /api/schemas/recommendations
POST /api/extraction-jobs
GET /api/extraction-jobs/{job_id}
PATCH /api/extraction-results/{result_id}
GET /api/extraction-results/{result_id}/export?format=json|csv
```

## 4. Frontend

첫 화면은 `Digitize Your Document` 홈이다.

기능 카드:

- Raw Data Extractor: enabled
- Key Information Extractor: enabled
- OCR: disabled, coming soon
- Intelligence Parse: disabled, coming soon

Raw workspace:

- KIE와 유사한 좌우 split layout
- 좌측: PDF preview
- 우측: HTML preview, upload/open/download controls, recent raw list

KIE workspace:

- 기존 upload/schema/review 흐름 유지
- Home navigation 제공

## 5. 환경

Python은 conda가 아니라 `uv` 기반 `.venv`를 사용한다.

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'
```

`backend/pyproject.toml`이 바뀌면 같은 설치 명령으로 `.venv`를 업데이트한다.

환경변수:

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
```

`LIBREOFFICE_PATH`는 선택값이다. 기본 macOS 경로는 `/Applications/LibreOffice.app/Contents/MacOS/soffice`이다.

## 6. 테스트 기준

Backend:

- health/system status
- image/PDF document upload
- schema create/update
- KIE extraction failure without credentials
- KIE mock extraction success
- raw PDF upload and HTML extraction
- raw docx/xlsx/pptx upload with LibreOffice conversion mocked
- dependency import smoke test

Frontend:

- `npm run build`
- 홈 화면 기능 카드 렌더링
- Raw Data Extractor upload/preview layout
- KIE 진입 및 기존 schema/review flow 유지
- mobile layout에서 카드와 split view가 겹치지 않음

## 7. 현재 제외 범위

- OCR 실제 실행
- Intelligence Parse 실제 실행
- legacy `.doc`, `.xls`, `.ppt` HTML 파싱
- 인증/권한
- 운영용 queue worker
- bbox 하이라이트
- PostgreSQL/Alembic migration
