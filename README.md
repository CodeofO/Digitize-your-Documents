<div align="center">
  <h1>Digitize Your Document</h1>
  <p><b>문서를 업로드하고, 원본 정보 추출과 스키마 기반 정보 추출을 한 화면에서 검증하는 React + FastAPI 워크스페이스</b></p>
  <p>
    <code>React</code>
    <code>Vite</code>
    <code>TypeScript</code>
    <code>FastAPI</code>
    <code>SQLite</code>
    <code>LangChain</code>
    <code>LibreOffice</code>
    <code>PyMuPDF</code>
  </p>
</div>

## 2026-05-20 변경 사항

- KIE 업로드 화면에서 단일 문서 업로드와 배치 업로드를 함께 실행할 수 있도록 변경했습니다.
- 배치 업로드 후 좌측 문서 영역에 batch file sidebar를 추가했습니다. 50장 이상의 이미지/문서도 thumbnail과 상태를 보며 항목별로 이동할 수 있고, 선택한 항목의 결과는 우측 review 영역에 바로 표시됩니다.
- 배치 처리 진행률은 메인 화면에서 자동 갱신되며, CSV/JSON export는 기존처럼 batch 단위로 다운로드할 수 있습니다.
- 실제 VLM structured output 흐름을 핵심만 담은 `vlm_runtime_overview.html`과 README용 캡처 이미지를 추가했습니다.

![KIE VLM 작동 원리](assets/vlm_runtime_overview.png)

## 핵심 기능

| 기능 | 상태 | 설명 |
| --- | --- | --- |
| Raw Data Extractor | 구현 | `.docx`, `.xlsx`, `.pptx`, `.pdf`를 업로드하면 PDF preview와 HTML 정보 추출 결과를 생성합니다. |
| Key Information Extractor | 구현 | PDF/image/DOCX/PPTX 문서를 업로드하고 사용자가 정의한 schema 기준으로 VLM structured output 값을 추출합니다. |
| OCR | 예정 | 단순 OCR 기능으로 확장 예정입니다. |
| Intelligence Parse | 예정 | 문서를 지능적으로 파싱하는 기능으로 확장 예정입니다. |

## 사용 도구

| 영역 | 도구 |
| --- | --- |
| Frontend | React 19, Vite 7, TypeScript, lucide-react |
| Backend API | FastAPI, Uvicorn, Pydantic Settings |
| Database | SQLite, SQLAlchemy |
| VLM | LangChain, langchain-openai, structured output |
| PDF/Image | PyMuPDF |
| Office Preview | LibreOffice `soffice` CLI |
| DOCX Parsing | mammoth, OOXML fallback |
| XLSX Parsing | openpyxl |
| PPTX Parsing | python-pptx, OOXML fallback |
| HTML Safety | bleach sanitize, sandboxed iframe |
| Dev/Test | uv, pytest, npm, Vite build |

## 빠른 실행

Python은 conda가 아니라 `uv` 기반 `.venv`를 사용합니다.

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'
```

Frontend 의존성을 설치합니다.

```bash
cd frontend
npm ci
cd ..
```

Backend와 frontend를 한 번에 실행합니다.

```bash
./scripts/run_dev.sh
```

기본 주소:

| 서버 | 주소 | 개발 반영 |
| --- | --- | --- |
| Backend | `http://127.0.0.1:8000` | `backend/app` 변경 시 `uvicorn --reload` |
| Frontend | `http://127.0.0.1:5173` | Vite dev server |

`scripts/run_dev.sh`의 backend reload 감시 범위는 `.venv`, local DB, storage output 변경으로 extraction 작업이 재시작되지 않도록 `backend/app`으로 제한합니다.
`run_dev.sh`는 실행 전에 backend 핵심 의존성(`pymupdf`, `bleach`)과 frontend 핵심 패키지 파일을 점검합니다. `node_modules`가 없거나 불완전하면 lockfile 기준 `npm ci`로 복구합니다.

## 설정

Home 화면 우측 상단 `Setting` 버튼에서 API key, model name, LibreOffice path를 저장합니다. Save를 누르면 프로젝트 root의 `.env`가 자동 생성 또는 갱신됩니다.

주요 값:

```env
APP_ENV=local
VLM_PROVIDER=openai
VLM_API_KEY=
VLM_MODEL_NAME=
VLM_BASE_URL=
VLM_TEMPERATURE=0
VLM_MAX_RETRIES=2
VLM_TIMEOUT_SECONDS=120
BATCH_MAX_WORKERS=4
LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

로컬 데모에서 실제 VLM 호출을 피하려면 root `.env`에 아래 값을 둘 수 있습니다.

```env
VLM_PROVIDER=mock
```

## LibreOffice

LibreOffice는 Python 패키지가 아니라 OS 레벨 앱/CLI입니다. Office 문서의 PDF preview 생성을 위해 backend가 외부 `soffice` 명령을 호출합니다.

macOS 설치:

```bash
brew install --cask libreoffice
soffice --version
```

자동 탐색이 되지 않으면 Home 설정 또는 `.env`에서 경로를 지정합니다.

```env
LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

## Raw Data Extractor

지원 포맷:

| 포맷 | PDF preview | HTML 추출 |
| --- | --- | --- |
| `.docx` | LibreOffice 변환 | mammoth + OOXML fallback |
| `.xlsx` | LibreOffice 변환 | openpyxl sheet table |
| `.pptx` | LibreOffice 변환 | python-pptx slide text/table/image |
| `.pdf` | 원본 복사 | PyMuPDF page text/image |

처리 흐름:

1. 원본 문서를 업로드합니다.
2. Backend가 `backend/storage/raw/{id}/original.ext`에 저장합니다.
3. Backend가 `preview.pdf`를 생성합니다.
4. Backend가 `content.html`을 생성합니다.
5. UI 좌측은 PDF preview, 우측은 HTML preview를 표시합니다.

업로드 옵션:

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `include_images` | on | 지원 가능한 embedded raster image를 HTML에 data URL로 포함합니다. |
| `include_formulas` | off | XLSX formula와 DOCX/PPTX Office Math 텍스트를 포함합니다. |

Raw API:

| Method | Path |
| --- | --- |
| `POST` | `/api/raw-extractions` |
| `GET` | `/api/raw-extractions?limit=20` |
| `GET` | `/api/raw-extractions/{id}` |
| `GET` | `/api/raw-extractions/{id}/pdf` |
| `GET` | `/api/raw-extractions/{id}/html` |

## Key Information Extractor

지원 입력:

| 포맷 | 처리 |
| --- | --- |
| `.pdf` | page image로 rasterize 후 VLM에 전달 |
| `.png`, `.jpg`, `.jpeg` | 1페이지 문서로 저장 후 VLM에 전달 |
| `.docx`, `.pptx` | LibreOffice로 PDF 변환 후 page image로 rasterize |

스키마 필드:

| 필드 | 설명 |
| --- | --- |
| `key_name` | 추출할 값의 키 이름 |
| `description` | 문서 내 위치, 의미, 추출 기준 |
| `output_format` | `string`, `float`, `date`, `bool` |
| `region_id` | 선택 항목. schema-level region을 참조하는 ID |

`regions`는 schema 최상위에 저장됩니다. 각 region은 `id`, `name`, `page`, `x`, `y`, `width`, `height`로 구성하며 `x/y/width/height`는 0~1 사이 상대 좌표입니다. 여러 field가 같은 `region_id`를 참조할 수 있고, `region_id`가 없는 field는 전체 문서에서 추출합니다. Batch extraction은 저장된 schema version을 그대로 사용하므로 region template도 함께 재사용됩니다.

Region field는 VLM 입력 시 두 이미지를 함께 사용합니다. 하나는 region 외부를 흐리게 만든 원본 page context이고, 다른 하나는 실제 판독용 crop입니다. 따라서 description에 “우측 하단” 같은 위치 표현이 있어도 원본 page 위치 맥락과 crop 집중도를 함께 제공합니다.

KIE 추출은 group 단위로 나뉩니다. `region_id`가 없는 field들은 full-page group 1회로 추출하고, `region_id`가 있는 field들은 사용 중인 region별로 묶어 각각 추출합니다. 따라서 호출 수는 `full-page field가 있으면 1회 + 사용 중인 region 수`입니다.

KIE 결과 확인 후 다른 문서를 다시 로드하려면 좌측 Document toolbar의 `Replace`를 사용합니다. 현재 schema는 유지하고 문서/결과만 교체됩니다. `Clear`는 현재 문서와 결과를 비우고 업로드 화면으로 돌아갑니다.

Batch extraction:

- KIE 메인 업로드 화면에서 저장된 schema 하나를 선택하고 여러 파일 또는 폴더를 업로드해 같은 기준으로 KIE 추출을 실행합니다.
- Batch 실행 후 좌측 문서 영역의 batch file sidebar에서 각 파일을 이동할 수 있습니다. 선택한 파일의 문서 preview와 추출 결과가 같은 화면에서 갱신됩니다.
- Batch 내부 파일들은 `BATCH_MAX_WORKERS` 개수까지 병렬로 VLM extraction을 실행합니다.
- Batch sidebar 또는 batch 결과 목록에서 `CSV` 또는 `JSON`을 눌러 batch 전체 결과를 즉시 다운로드할 수 있습니다.
- Running/queued batch는 `Stop`으로 중단 요청할 수 있습니다. 이미 VLM 호출 중인 파일은 현재 호출이 끝난 뒤 취소 상태로 정리됩니다.

KIE API:

| Method | Path |
| --- | --- |
| `GET` | `/api/health` |
| `GET` | `/api/system/status` |
| `GET` | `/api/settings/vlm` |
| `PUT` | `/api/settings/vlm` |
| `POST` | `/api/documents` |
| `GET` | `/api/documents?limit=20` |
| `POST` | `/api/schemas` |
| `GET` | `/api/schemas` |
| `PATCH` | `/api/schemas/{schema_id}` |
| `POST` | `/api/schemas/recommendations` |
| `POST` | `/api/extraction-jobs` |
| `GET` | `/api/extraction-jobs/{job_id}` |
| `PATCH` | `/api/extraction-results/{result_id}` |
| `GET` | `/api/extraction-results/{result_id}/export?format=json\|csv` |
| `POST` | `/api/batches` |
| `GET` | `/api/batches?limit=20` |
| `POST` | `/api/batches/{batch_id}/cancel` |
| `GET` | `/api/batches/{batch_id}/export?format=csv\|json` |

## 문서와 구조

| 파일 | 설명 |
| --- | --- |
| `DEVELOPMENT_DEFINITION.md` | 제품 기준 개발정의서 |
| `ERROR_NOTE.md` | 중요 오류와 수정 검증 기록 |
| `architecture_overview.html` | 기능, 데이터 구조, 처리 흐름을 한눈에 보는 HTML 아키텍처 문서 |
| `vlm_runtime_overview.html` | KIE에서 실제 VLM structured output이 작동하는 흐름을 요약한 HTML 문서 |
| `assets/vlm_runtime_overview.png` | README에 포함되는 VLM 작동 원리 캡처 이미지 |
| `sync_raw_to_pdf.py` | LibreOffice PDF 변환 참고 스크립트 |

디렉터리:

```text
.
├── backend/                  # FastAPI, SQLite, 문서 처리, VLM, raw extraction
├── frontend/                 # Vite + React + TypeScript UI
├── scripts/run_dev.sh        # backend/frontend 동시 실행
├── DEVELOPMENT_DEFINITION.md
├── ERROR_NOTE.md
├── architecture_overview.html
├── vlm_runtime_overview.html
├── assets/
│   └── vlm_runtime_overview.png
└── README.md
```

## 테스트

Backend:

```bash
.venv/bin/python -m pytest backend
```

Frontend:

```bash
cd frontend
npm run build
```

Backend 테스트는 Office 파일의 LibreOffice 변환을 mock 처리합니다. 실제 Office to PDF 변환은 로컬 smoke test로 확인합니다.

## 아키텍처 변경 이력

상세 시각화 문서는 `architecture_overview.html`, `kie_extraction_visualization.html`, `vlm_runtime_overview.html`을 확인합니다.

| Version | 구조 | 내용 |
| --- | --- | --- |
| v0.1 | KIE MVP | 전체 page image와 schema fields를 한 번에 VLM structured output으로 추출했습니다. |
| v0.2 | Field-owned region | 각 field가 optional `region` 좌표를 직접 소유하고, region field에 crop image를 추가했습니다. |
| v0.3 | Schema-level region | `schema.regions`를 최상위에 두고 여러 field가 같은 `region_id`를 참조하도록 바꿨습니다. |
| v0.4 | Masked context | region crop과 함께 region 외부를 흐리게 만든 원본 page context를 VLM 입력에 추가했습니다. |
| v0.5 | Grouped extraction | `region_id` 없는 field는 full-page group 1회, region field는 사용 중인 region별 1회로 분리 호출하고 결과를 merge합니다. |

현재 KIE 호출 수는 `full-page field가 있으면 1회 + 사용 중인 region 수`입니다.

## 운영 메모

- SQLite DB 기본 파일명은 `backend/digitize_documents.db`입니다.
- 업로드 문서와 raw extraction 결과는 `backend/storage/` 아래에 저장됩니다.
- `.env`, `.venv`, local DB, storage output, `node_modules`, frontend build artifact는 git에서 제외됩니다.
- `.env.example` 복사는 필요하지 않습니다. Home Setting에서 `.env`를 생성합니다.
