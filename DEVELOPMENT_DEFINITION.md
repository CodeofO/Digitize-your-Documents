# Digitize Your Document 개발정의서

문서 목적: `Digitize Your Document`의 현재 MVP 범위, UX, API, 데이터 처리 방식, 검증 기준을 정의한다.

## 1. 제품 정의

Digitize Your Document는 다양한 문서를 디지털 정보로 변환하는 React + FastAPI 워크스페이스이다.

현재 구현 기능:

- **Raw Data Extractor**: Office/PDF 문서를 PDF preview와 HTML 정보 추출 결과로 변환
- **Key Information Extractor**: 사용자가 정의한 schema 기준으로 PDF/image/DOCX/PPTX에서 key information 추출

예정 기능:

- **OCR**: 단순 텍스트 OCR
- **Intelligence Parse**: 문서를 구조와 의미 기준으로 지능형 파싱

설계 원칙:

- Python 친화적인 backend 중심 구조를 유지한다.
- VLM secret은 frontend로 전달하지 않는다.
- Home 화면 우측 상단 Setting popup에서 VLM API key/model name과 LibreOffice path를 저장하면 root `.env`가 자동 생성/갱신된다.
- 사용자는 별도 환경 파일 복사 절차 없이 git clone 후 Home에서 설정할 수 있다.

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
6. schema 저장 후 extraction을 실행한다.
7. 결과 table에서 value, normalized value, status, page, confidence, warning을 검토한다.
8. 사용자는 결과를 수정하고 JSON/CSV로 export한다.

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

지원 입력:

- `.pdf`
- `.png`
- `.jpg`
- `.jpeg`
- `.docx`
- `.pptx`

DOCX/PPTX는 LibreOffice로 PDF 변환 후 page image로 rasterize한다. 이후 VLM에는 기존과 동일하게 page image data URL을 전달한다.

## 4. Frontend

첫 화면은 `Digitize Your Document` Home이다.

기능 카드:

- Raw Data Extractor: enabled
- Key Information Extractor: enabled
- OCR: disabled, coming soon
- Intelligence Parse: disabled, coming soon

Home 우측 상단 Setting 버튼:

- API key/model name 입력 popup 표시
- LibreOffice path 입력. 기본값은 `/Applications/LibreOffice.app/Contents/MacOS/soffice`
- Save 시 root `.env` 생성/갱신 후 popup 닫기
- X 또는 Close 클릭 시 저장하지 않고 popup 닫기

Raw workspace:

- 좌측: PDF preview
- 우측: HTML preview, upload/open/download controls, recent raw list

Key Information workspace:

- 기존 upload/schema/review 흐름 유지
- Home navigation 제공

브라우저 Back:

- Home에서 기능 진입 시 URL hash를 `#raw`, `#key-info`로 갱신한다.
- 브라우저 Back을 누르면 browser 초기 화면이 아니라 app Home으로 돌아온다.

## 5. 환경

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
VLM_PROVIDER=openai
VLM_API_KEY=
VLM_MODEL_NAME=
VLM_BASE_URL=
VLM_TEMPERATURE=0
VLM_MAX_RETRIES=2
VLM_TIMEOUT_SECONDS=120
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

## 6. 테스트 기준

Backend:

- health/system status
- VLM settings read/write
- image/PDF/DOCX/PPTX document upload
- schema create/update
- extraction failure without credentials
- mock extraction success
- raw PDF upload and HTML extraction
- raw PDF image extraction option
- raw Office upload with LibreOffice conversion mocked
- raw XLSX formula extraction option
- result correction/export

Frontend:

- Home 화면의 기능 카드 진입
- Home VLM settings popup 열기/저장/닫기
- 브라우저 Back으로 app Home 복귀
- Recent/Search archive/Batch results utility modal 열기/닫기
- KIE 메인 업로드 화면에서 단일 문서 업로드와 batch 업로드를 함께 제공
- Batch upload에서 schema 선택, 복수 파일/폴더 업로드, worker 제한 병렬 처리, running batch progress polling, batch 중단, batch CSV/JSON export
- Batch 실행 후 좌측 batch file sidebar에서 1페이지 thumbnail과 상태를 보며 파일 이동, 우측 review 영역에서 선택 파일 결과 즉시 확인
- Raw Data Extractor upload/preview layout
- 이미지/수식 추출 옵션 toggle
- Key Information Extractor 진입 및 schema/review flow 유지
- KIE schema-level extraction region 지정/저장 및 field별 region 할당
- 모바일 폭에서 layout overlap 없음

Integration:

- `./scripts/run_dev.sh`로 backend/frontend 동시 실행
- `.docx`, `.xlsx`, `.pptx`, `.pdf` raw extraction smoke test
- LibreOffice 누락/실패 시 UI error 확인

## 7. 제외 범위

- 사용자 인증/권한
- PostgreSQL 운영 DB
- 분산 queue
- review 화면 bbox highlight overlay
- 분산 queue 기반 대량 batch processing
- OCR 실제 구현
- Intelligence Parse 실제 구현
