# Digitize Your Document 개발정의서

문서 목적: `Digitize Your Document`로 대량 문서 추출 업무를 자동화하기 위한 현재 MVP 범위, UX, API, 데이터 처리 방식, 검증 기준을 정의한다.

## 1. 제품 정의

Digitize Your Document는 사람이 대량 문서에서 반복적으로 확인하던 값을 자동 추출, 검토, export할 수 있게 만드는 React + FastAPI 워크스페이스이다.

핵심 자동화 가치:

- 이미지/PDF/Office 문서에서 필요한 값만 schema 기준으로 추출한다.
- 50장 이상의 batch 문서도 파일명 기준 정렬, 병렬 처리, progress 확인, 일괄 export가 가능하다.
- 문서 원문은 PDF preview와 HTML 추출 결과로 확인하고, 핵심 값은 VLM structured output으로 검증 가능한 형태로 저장한다.

현재 구현 기능:

- **Raw Data Extractor**: Office/PDF 문서를 PDF preview와 HTML 정보 추출 결과로 변환
- **Key Information Extractor**: 사용자가 정의한 schema 기준으로 PDF/image/DOCX/PPTX에서 key information 추출
- **Document Classifier**: 사용자가 정의한 후보 class와 unknown 허용 규칙으로 문서 종류 분류
- **Required Field Checker**: 값의 정확성이 아니라 필수 항목 존재/누락/불확실 여부 확인

예정 기능:

- **Workflow Builder**: 모듈을 드래그 앤 드롭으로 연결하는 문서 처리 파이프라인

설계 원칙:

- Python 친화적인 backend 중심 구조를 유지한다.
- VLM secret은 frontend로 전달하지 않는다.
- Home 화면 우측 상단 Setting popup에서 VLM API key/model name과 LibreOffice path를 저장하면 root `.env`가 자동 생성/갱신된다.
- VLM 호출 방식은 `.env`의 API key와 base URL을 기반으로 자동 결정한다. `VLM_BASE_URL`이 있으면 OpenAI-compatible, `AIza` key이면 Google GenAI native Gemini, 그 외는 OpenAI-compatible로 호출한다.
- VLM runtime parameter는 `.env`와 Setting popup에서 제어한다. Thinking 계열 모델은 기본 `reasoning_effort=minimal`, `verbosity=low`로 빠른 추출을 우선한다.
- 사용자는 별도 환경 파일 복사 절차 없이 git clone 후 Home에서 설정할 수 있다.

### 1.1 2026-05-22 안정화 완료 범위

| ID | 내용 |
| --- | --- |
| P0-1 | VLM 실패를 `VLM_*` stable code로 표준화 |
| P0-2 | Provider 오류 메시지의 API key redaction |
| P0-3 | Credentials/provider/응답/설정값 오류를 job 저장과 HTTP detail에서 일관 처리 |
| P0-4 | Document Classifier `unknown`/`needs_review`의 `class_name=null` 허용 및 정규화 |
| P0-5 | Batch cancel로 모든 job이 terminal이면 batch `completed_at` 즉시 기록 |
| P1-6 | Classifier/Required Field Checker polling에 `cache: no-store` 적용 |
| P1-7 | 일시적 module batch polling 실패 시 기존 sidebar 상태 유지 |
| P1-8 | KIE/Classifier/Required batch CSV export UTF-8 BOM/charset 검증 |
| P2-9 | README와 개발정의서를 현재 동작 기준으로 갱신 |
| P2-10 | log/coverage/test report/cache/temp backup 등 로컬 산출물 ignore 명시 |

## 2. Raw Data Extractor

### 2.1 UX

1. 사용자가 Home 화면에서 Raw Data Extractor를 선택한다.
2. `.docx`, `.xlsx`, `.pptx`, `.pdf` 파일을 업로드한다.
3. backend가 원본 파일을 저장한다.
4. backend가 LibreOffice로 PDF preview를 생성한다. PDF 입력은 그대로 복사한다.
5. backend가 포맷별 Python parser로 HTML 정보를 생성한다.
6. frontend 좌측은 PDF preview iframe, 우측은 HTML preview iframe을 보여준다.
7. 사용자는 옵션으로 이미지 추출과 수식 추출을 켤 수 있다.
8. 사용자는 최근 raw extraction 목록에서 이전 결과를 다시 열 수 있다.

### 2.2 API

```http
POST /api/raw-extractions
GET /api/raw-extractions?limit=20
GET /api/raw-extractions/{id}
GET /api/raw-extractions/{id}/pdf
GET /api/raw-extractions/{id}/html
```

`POST /api/raw-extractions`는 multipart `file`과 form option `include_images`, `include_formulas`를 받는다. `include_images`의 UI/API 기본값은 true이고, `include_formulas`의 기본값은 false이다.

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

- `.docx`: `mammoth`로 semantic HTML 생성 후 `bleach`로 sanitize. 이미지 옵션은 `mammoth.images.data_uri`를 사용하고, 수식 옵션은 OOXML `m:oMath`의 `m:t` 텍스트를 추가 추출한다.
- `.xlsx`: `openpyxl` read-only 모드로 sheet별 HTML table 생성. 수식 옵션은 `data_only=False` workbook을 병행해서 formula cell을 렌더링한다. 이미지 옵션은 `xl/media/`의 browser 지원 이미지 파일을 HTML에 포함한다.
- `.pptx`: `python-pptx`로 slide text/table/image를 section 단위 HTML로 생성한다. 수식 옵션은 slide XML의 OOXML `m:oMath` 텍스트를 추가 추출한다.
- `.pdf`: PyMuPDF로 page text block을 HTML section으로 생성한다. 이미지 옵션은 page image xref를 추출해 HTML에 포함한다.

### 2.5 PDF 변환

LibreOffice headless 변환을 사용한다. 변환 구조는 `sync_raw_to_pdf.py`의 OS별 LibreOffice 경로 탐색, 임시 디렉터리 변환, 결과 PDF 이동 패턴을 참고한다.

필터:

- `.docx`: `writer_pdf_Export`
- `.xlsx`: `calc_pdf_Export`
- `.pptx`: `impress_pdf_Export`
- `.pdf`: 변환 없이 복사

LibreOffice가 없거나 변환에 실패하면 row는 `status=failed`로 저장하고 `error_message`를 반환한다.

## 3. Key Information Extractor

### 3.1 UX

1. 사용자가 Home 화면에서 Key Information Extractor를 선택한다.
2. PDF/image/DOCX/PPTX 문서를 업로드한다.
3. 좌측 문서 viewer에서 페이지를 확인한다.
4. 우측 schema builder에서 `key_name`, `description`, `output_format`을 정의한다.
5. 필요 필드만 선택적으로 extraction region을 지정한다.
6. 저장된 schema는 `Schema Library` drawer의 카드형 리스트에서 선택한다.
7. schema는 version 없이 이름 단위로 현재 내용만 관리한다.
8. 사용자가 field, schema description, region을 수정하면 debounce 후 자동 저장한다. 별도 저장 버튼을 찾지 않아도 현재 schema 내용이 유지되어야 한다.
9. 사용자가 필드를 수정한 뒤 `AI 수정`으로 현재 필드만 기반으로 schema-level description을 다시 생성할 수 있다. 문서 이미지는 필요하지 않다.
10. 결과 table에서 value, normalized value, status, page, confidence, warning을 검토한다.
11. 사용자는 결과를 수정하고 JSON/CSV로 export한다.

### 3.2 Schema

필드 구조:

```json
{
  "regions": [
    {
      "id": "region_1",
      "name": "하단 손글씨 영역",
      "page": 1,
      "x": 0.12,
      "y": 0.78,
      "width": 0.2,
      "height": 0.06
    }
  ],
  "fields": [
    {
      "key_name": "account_date",
      "description": "좌측 하단의 계정일자",
      "output_format": "date",
      "region_id": "region_1"
    }
  ]
}
```

`output_format`은 MVP에서 아래 값만 지원한다.

- `string`
- `float`
- `date`
- `bool`

`regions`는 schema 최상위에서 관리한다. 각 region은 `id`, `name`, `page`, `x`, `y`, `width`, `height`를 갖고 좌표는 원본 page image 기준 0~1 상대 좌표로 저장한다. field는 선택적으로 `region_id`를 참조한다. 여러 field가 같은 region을 참조할 수 있고, `region_id`가 없는 field는 전체 문서에서 추출한다.

### 3.3 VLM

- LangChain `with_structured_output`을 사용한다.
- 동적 JSON schema는 사용자 schema field를 기준으로 생성한다.
- 문서 page image는 base64 data URL로 전달한다.
- OpenAI-compatible endpoint는 LangChain `ChatOpenAI.with_structured_output(method="json_schema", strict=True)`로 호출한다.
- Google GenAI native Gemini는 `google-genai` SDK의 `models.generate_content`에 `response_mime_type="application/json"`, `response_json_schema=<동적 JSON schema>`, `types.Part.from_bytes(...)` image part를 전달한다.
- 공통 runtime parameter는 `.env`에서 제어한다. `VLM_REASONING_EFFORT=minimal`, `VLM_VERBOSITY=low`를 기본값으로 두어 thinking 모델도 빠른 응답을 우선한다.
- 선택 parameter로 `VLM_MAX_COMPLETION_TOKENS`, `VLM_TOP_P`, `VLM_SERVICE_TIER`를 지원한다. 값이 비어 있으면 해당 parameter는 VLM 호출에 전달하지 않는다.
- `region_id`가 있는 field는 해당 region crop을 함께 전달한다.
- region field에는 원본 page에서 region 외부를 흐리게 만든 masked context image도 함께 전달한다.
- 하나의 region은 여러 field의 primary source가 될 수 있다.
- `region_id`가 없는 field는 기존처럼 full page image를 사용한다.
- VLM 호출은 group 단위로 수행한다. `region_id`가 없는 field들은 full-page group 1회로 추출하고, `region_id`가 있는 field들은 사용 중인 region별 group으로 나눠 추출한다.
- Extraction worker는 DB session을 VLM 호출 중 유지하지 않는다. Job/document/schema/page 정보는 호출 전에 snapshot으로 복사하고, 결과 저장과 실패 저장은 짧은 별도 session에서 처리한다.
- 호출 수는 `full-page field가 있으면 1회 + 사용 중인 region 수`이다.
- 각 group 호출의 structured output schema는 해당 group field만 포함한다.
- VLM 응답이 stringified JSON이면 실패 처리한다.
- 저장되는 결과는 사용자 schema에 명시된 key만 허용한다.
- VLM 실패는 stable code를 갖는 `VLM_*` 오류로 표준화한다. Background job 실패는 `VLM_CODE: message` 형식의 `error_message`로 저장하고, 동기 API 실패는 `{code, message, hint}` detail로 반환한다.
- Provider 요청 실패 메시지에 API key가 포함되면 저장/반환 전에 `[redacted]`로 마스킹한다.
- 현재 사용하는 대표 code는 `VLM_CREDENTIALS_MISSING`, `VLM_PROVIDER_UNSUPPORTED`, `VLM_PROVIDER_REQUEST_FAILED`, `VLM_RESPONSE_INVALID_JSON`, `VLM_RESPONSE_STRING`, `VLM_SETTING_INVALID_INTEGER`, `VLM_SETTING_INVALID_NUMERIC`이다.

지원 입력:

- `.pdf`
- `.png`
- `.jpg`
- `.jpeg`
- `.docx`
- `.pptx`

DOCX/PPTX는 LibreOffice로 PDF 변환 후 page image로 rasterize한다. 이후 VLM에는 기존과 동일하게 page image data URL을 전달한다.

## 4. Document Classifier

### 4.1 목적

업로드된 문서가 어떤 종류인지 먼저 나누는 모듈이다. 사용자가 class 후보를 직접 정의하며, 후보에 맞지 않는 문서는 `unknown`으로 남길 수 있다. 이 모듈은 대량 문서가 섞여 들어오는 업무에서 downstream KIE/checklist 설정을 고르는 전처리 단계가 된다.

### 4.2 Config

```json
{
  "name": "loan_document_classifier",
  "description": "금융 업무 접수 문서를 종류별로 분류한다.",
  "allow_unknown": true,
  "classes": [
    {
      "class_name": "credit_information_inquiry_consent",
      "description": "개인신용정보 조회 동의서",
      "signals": ["고유식별정보", "개인신용정보", "동의함"]
    }
  ]
}
```

### 4.3 Result

```json
{
  "status": "classified",
  "class_name": "credit_information_inquiry_consent",
  "confidence": 0.91,
  "reason": "문서 제목과 동의 체크박스 영역이 후보 class signal과 일치한다.",
  "evidence": ["고유식별정보", "개인신용정보 조회 동의"]
}
```

상태:

- `classified`: 후보 class 중 하나로 판단됨
- `unknown`: 후보 class에 맞지 않고 unknown 허용
- `needs_review`: 판단 불확실 또는 unknown 미허용 상황

`unknown`과 `needs_review`에서는 `class_name`이 `null`일 수 있다. `unknown` 결과에 class 후보명이 섞여 들어오면 backend validation에서 `class_name=null`로 정규화한다.

### 4.4 API

```http
POST /api/document-classifiers
GET /api/document-classifiers
GET /api/document-classifiers/{classifier_id}
PATCH /api/document-classifiers/{classifier_id}
DELETE /api/document-classifiers/{classifier_id}
POST /api/classification-jobs
GET /api/classification-jobs/{job_id}
PATCH /api/classification-results/{result_id}
POST /api/classification-batches
GET /api/classification-batches
GET /api/classification-batches/{batch_id}
POST /api/classification-batches/{batch_id}/cancel
GET /api/classification-batches/{batch_id}/export?format=csv|json
```

## 5. Required Field Checker

### 5.1 목적

KIE보다 단순하게 필수 항목이 존재하는지만 확인한다. 값의 정확성은 보지 않는다. 예를 들어 성명, 작성일, 서명, 도장, 동의 체크박스가 비어 있는지 빠르게 거른다.

### 5.2 Config

```json
{
  "name": "consent_required_fields",
  "description": "동의서 접수 전 필수 표시 여부를 확인한다.",
  "regions": [
    {
      "id": "signature_region",
      "name": "서명 영역",
      "page": 1,
      "x": 0.55,
      "y": 0.75,
      "width": 0.35,
      "height": 0.12
    }
  ],
  "items": [
    {
      "item_name": "서명",
      "description": "서명 또는 날인이 존재하는지 확인한다.",
      "evidence_type": "signature_or_stamp",
      "required": true,
      "region_id": "signature_region"
    }
  ]
}
```

`evidence_type`:

- `text_or_handwriting`
- `checkbox`
- `signature_or_stamp`
- `visual_mark`
- `other`

### 5.3 Result

```json
{
  "overall_status": "incomplete",
  "items": [
    {
      "item_name": "서명",
      "status": "missing",
      "required": true,
      "evidence_type": "signature_or_stamp",
      "confidence": 0.72,
      "evidence": "서명 영역에 필기 또는 날인이 보이지 않음",
      "page": 1
    }
  ]
}
```

overall status:

- `complete`
- `incomplete`
- `needs_review`

item status:

- `present`
- `missing`
- `uncertain`
- `not_applicable`

### 5.4 API

```http
POST /api/required-field-checklists
GET /api/required-field-checklists
GET /api/required-field-checklists/{checklist_id}
PATCH /api/required-field-checklists/{checklist_id}
DELETE /api/required-field-checklists/{checklist_id}
POST /api/required-field-check-jobs
GET /api/required-field-check-jobs/{job_id}
PATCH /api/required-field-check-results/{result_id}
POST /api/required-field-check-batches
GET /api/required-field-check-batches
GET /api/required-field-check-batches/{batch_id}
POST /api/required-field-check-batches/{batch_id}/cancel
GET /api/required-field-check-batches/{batch_id}/export?format=csv|json
```

두 모듈의 config 삭제는 KIE schema와 동일하게 archive 처리한다. 과거 결과는 유지한다.

## 6. Frontend

첫 화면은 `Digitize Your Document` Home이다.

기능 카드:

- Raw Data Extractor: enabled
- Key Information Extractor: enabled
- Document Classifier: enabled
- Required Field Checker: enabled
- Workflow Builder: disabled, coming soon

### 6.1 디자인 원칙

- 표로 표현 가능한 정보는 표 형태로 통일한다. KIE field table을 기준 스타일로 삼고, Document Classifier class 후보, Required Field Checker checklist item, 결과/review table도 같은 시각 문법을 따른다.
- 표는 얇은 외곽선, 연한 header background, 셀 경계선, 좌측 정렬, 충분한 행 높이를 가진다.
- 셀 안의 input, textarea, select는 반복적인 둥근 버블처럼 보이지 않게 하고, 표 안에서 자연스럽게 편집 가능한 형태로 둔다.
- 긴 description, reason, evidence는 줄바꿈으로 전문을 볼 수 있게 한다. 말줄임 때문에 업무 판단 근거가 가려지면 안 된다.
- 라이브러리 패널은 가능한 overlay가 아니라 push sidebar로 연다. 사용자가 문서 preview와 설정 table을 계속 클릭하고 조정할 수 있어야 한다.
- 문서 preview와 설정/결과 영역은 기본 50:50 분할이며, 사용자가 조정한 비율은 유지한다.
- 단일/배치 업로드는 사용자 입력 개수로 자동 판단한다. 1개 파일은 single, 2개 이상 또는 folder는 batch로 전환한다.
- 배치 파일 목록은 파일명 오름차순으로 정렬하고, 선택 이동 중 전역 alert로 layout이 흔들리지 않게 한다.
- 카드 UI는 Home 기능 선택, library item, modal성 도구처럼 경계가 필요한 곳에만 사용한다. field/class/checklist 같은 반복 편집 대상은 table을 우선한다.

### 6.2 Home / 공통

Home 우측 상단 Setting 버튼:

- API key/model name 입력 popup 표시
- LibreOffice path 입력. 기본값은 `/Applications/LibreOffice.app/Contents/MacOS/soffice`
- Save 시 root `.env` 생성/갱신 후 popup 닫기
- X 또는 Close 클릭 시 저장하지 않고 popup 닫기

### 6.3 모듈별 화면

Raw workspace:

- 좌측: PDF preview
- 우측: HTML preview, upload/open/download controls, recent raw list

Key Information workspace:

- 기존 upload/schema/review 흐름 유지
- 메인 schema panel은 field table 중심으로 유지하고, schema 선택/이름/설명/템플릿/JSON/region 관리는 `Schema Library` drawer에서 제공한다.
- Schema description 옆에 `AI 수정` action을 제공한다. 이 action은 현재 field list만 VLM에 전달해 schema-level description을 갱신하며, 변경 내용은 자동 저장 대상이 된다.
- 같은 schema name이 이미 저장되어 있으면 신규 schema 생성을 막고, 기존 schema는 `Schema Library` list에서 선택해 수정하도록 안내한다.
- Schema 삭제는 과거 extraction/archive 참조를 보존하기 위해 물리 삭제가 아니라 `archived` 처리로 목록에서 숨긴다.
- Recent items 진입 버튼은 제거하고, schema 재사용은 `Schema Library` list로 옮긴다.
- Home navigation 제공
- Batch draft와 batch result sidebar는 파일명 기준 오름차순으로 표시한다.
- Batch export CSV/JSON도 파일명 기준 오름차순으로 row를 정렬한다.

Document Classifier workspace:

- 좌측은 단일/배치 업로드, 문서 preview, batch file rail을 제공한다.
- 우측은 classifier config table, 실행 버튼, 결과 table을 제공한다.
- classifier library는 schema library와 같은 push sidebar 방식으로 열리며 기존 작업 영역을 덮지 않는다.
- class 후보는 `class_name`, `description`, `signals`로 구성한다.
- `allow_unknown` toggle을 제공한다.
- 결과는 `classified`, `unknown`, `needs_review` 상태와 class, confidence, reason, evidence를 보여준다.
- 사용자는 결과 class를 수정하고 reviewed 상태로 저장할 수 있다.
- 1개 파일은 single job, 2개 이상은 batch job으로 자동 실행한다.

Required Field Checker workspace:

- 좌측은 단일/배치 업로드, 문서 preview, batch file rail을 제공한다.
- 우측은 checklist item table, AI 추천 버튼, 저장/실행 버튼, 결과 table을 제공한다.
- checklist library는 push sidebar 방식으로 제공한다.
- `AI 추천`은 현재 업로드된 문서 이미지를 VLM에 전달해 checklist name/description/items/regions 초안을 생성한다. 추천은 즉시 저장하지 않고 사용자가 검토 후 저장한다.
- item은 `item_name`, `description`, `evidence_type`, `required`, optional `region_id`로 구성한다.
- region은 KIE와 동일하게 0~1 상대 좌표로 저장하며 여러 item이 같은 region을 공유할 수 있다.
- 결과는 overall `complete`, `incomplete`, `needs_review`와 item별 `present`, `missing`, `uncertain`, `not_applicable`을 표시한다.
- 값의 정확성, 날짜/금액 형식, 외부 DB 일치 여부는 확인하지 않는다.
- 1개 파일은 single job, 2개 이상은 batch job으로 자동 실행한다.

Maintenance:

- Setting popup에서 파싱 기록 삭제 버튼을 제공한다.
- 삭제 범위는 documents, document pages, extraction jobs/results, batches, raw extractions, audit events, one-off draft schemas와 관련 local storage이다.
- 사용자가 저장한 schema와 export preset은 유지한다.

브라우저 Back:

- Home에서 기능 진입 시 URL hash를 `#raw`, `#key-info`, `#classifier`, `#required-checker`로 갱신한다.
- 브라우저 Back을 누르면 browser 초기 화면이 아니라 app Home으로 돌아온다.

## 7. 환경

Python은 conda가 아니라 `uv` 기반 `.venv`를 사용한다.

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'
```

`backend/pyproject.toml`이 바뀌면 같은 설치 명령으로 `.venv`를 업데이트한다.
PyMuPDF는 `pymupdf` import를 우선 사용하고, 구버전 호환을 위해 `fitz` fallback을 둔다.

Frontend 의존성은 lockfile 기준으로 재현 가능하게 설치한다.

```bash
cd frontend
npm ci
```

VLM 환경변수는 Home 화면의 Save를 통해 root `.env`에 자동 저장한다.

```env
APP_ENV=local
VLM_PROVIDER=auto
VLM_API_KEY=
VLM_MODEL_NAME=
VLM_BASE_URL=
VLM_TEMPERATURE=0
VLM_MAX_RETRIES=2
VLM_TIMEOUT_SECONDS=120
VLM_REASONING_EFFORT=minimal
VLM_VERBOSITY=low
VLM_MAX_COMPLETION_TOKENS=
VLM_TOP_P=
VLM_SERVICE_TIER=
BATCH_MAX_WORKERS=8
LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

LibreOffice는 Python 패키지가 아니라 외부 시스템 앱/CLI이므로 `.venv` 안에 일반 pip 의존성처럼 설치하지 않는다.

macOS 설치 방법:

```bash
brew install --cask libreoffice
soffice --version
```

설치 후 자동 탐색이 되지 않으면 `.env`에 명시한다.

```env
LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

## 8. 테스트 기준

Backend:

- health/system status
- VLM settings read/write
- VLM reasoning/verbosity/max token/top_p/service tier runtime parameter 적용
- VLM error code, HTTP detail, secret redaction
- image/PDF/DOCX/PPTX document upload
- schema create/update
- extraction failure without credentials
- mock extraction success
- raw PDF upload and HTML extraction
- raw PDF image extraction option
- raw Office upload with LibreOffice conversion mocked
- raw XLSX formula extraction option
- result correction/export
- document classifier config CRUD/archive
- classification single job structured output 저장
- classification batch progress/cancel/export, CSV UTF-8 BOM, terminal cancel `completed_at`
- required field checklist config CRUD/archive
- required field checklist region validation
- required field check single job structured output 저장
- required field check batch progress/cancel/export, CSV UTF-8 BOM, terminal cancel `completed_at`

Frontend:

- Home 화면의 기능 카드 진입
- Home VLM settings popup 열기/저장/닫기
- 브라우저 Back으로 app Home 복귀
- Recent/Search archive/Batch results utility modal 열기/닫기
- KIE 메인 업로드 화면에서 단일 문서 업로드와 batch 업로드를 함께 제공
- Batch upload에서 schema 선택, 복수 파일/폴더 업로드, worker 제한 병렬 처리, running batch progress polling, batch 중단, batch CSV/JSON export
- Batch draft/sidebar/export row가 파일명 기준 오름차순으로 정렬되는지 확인
- Batch 실행 후 좌측 batch file sidebar에서 1페이지 thumbnail과 상태를 보며 파일 이동, 우측 review 영역에서 선택 파일 결과 즉시 확인
- Raw Data Extractor upload/preview layout
- 이미지/수식 추출 옵션 toggle
- Key Information Extractor 진입 및 schema/review flow 유지
- KIE schema-level extraction region 지정/저장 및 field별 region 할당
- Document Classifier 진입, class 후보 편집, unknown toggle, 단일/batch 실행, 결과 수정, export
- Required Field Checker 진입, AI checklist 추천, checklist item 편집, region 표시, 단일/batch 실행, 결과 수정, export
- Workflow Builder disabled 카드 표시
- 모바일 폭에서 layout overlap 없음

Integration:

- `./scripts/run_dev.sh`로 backend/frontend 동시 실행
- `.docx`, `.xlsx`, `.pptx`, `.pdf` raw extraction smoke test
- LibreOffice 누락/실패 시 UI error 확인

## 9. 제외 범위

- 사용자 인증/권한
- PostgreSQL 운영 DB
- 분산 queue
- review 화면 bbox highlight overlay
- 분산 queue 기반 대량 batch processing
- Workflow Builder 실제 실행 엔진

## 10. GitHub 문서와 저장소 정책

GitHub에 올라가는 문서는 제품 사용자가 바로 읽는 내용과 개발자가 실행에 필요한 내용만 유지한다.

추적 문서:

- `README.md`: 제품 가치, 기능, 실행, 설정, API, 테스트 요약
- `DEVELOPMENT_DEFINITION.md`: 현재 제품 정의, UX/API/data/test 기준
- `ERROR_NOTE.md`: 중요 오류, 원인, 영향, 수정, 검증 기록

추적 asset:

- `assets/readme_overview.png`
- `assets/vlm_runtime_overview.png`

로컬 전용 artifact:

- 실험/이해용 HTML 문서
- 디자인 스타일 로컬 메모
- sample 입력 파일
- local DB, storage, `.env`, `.venv`, `node_modules`, frontend build output
- log, coverage, test report, cache, temporary backup output

`.gitignore`는 default-deny allowlist 구조를 사용한다. 모든 파일을 먼저 무시하고, source/test/config/script/GitHub 문서/README asset만 `!` 패턴으로 추적한다. 새 파일을 Git에 올릴 때는 해당 파일이 제품 실행이나 GitHub 문서에 필요한지 먼저 판단하고, 필요할 때만 allowlist에 추가한다.
