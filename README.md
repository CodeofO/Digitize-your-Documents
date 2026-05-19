# Digitize Your Document

React + FastAPI 기반의 문서 디지털화 워크스페이스입니다. 현재 구현된 기능은 원본 정보 추출과 key information extraction이며, OCR과 Intelligence Parse는 이후 확장 예정입니다.

## 현재 기능

- **Raw Data Extractor**: `.docx`, `.xlsx`, `.pptx`, `.pdf`를 업로드하면 PDF preview와 HTML 추출 결과를 생성합니다.
- **Key Information Extractor**: PDF/image 문서를 업로드하고 사용자가 정의한 schema 기준으로 VLM structured output 값을 추출합니다.
- **Home VLM 설정**: Home 화면에서 API key와 model name을 입력하고 Save를 누르면 프로젝트 root `.env`가 자동 생성/갱신됩니다.

## 디렉터리

```text
.
├── backend/                   # FastAPI, SQLite, 문서 처리, VLM, raw extraction
├── frontend/                  # Vite + React + TypeScript UI
├── sync_raw_to_pdf.py         # LibreOffice PDF 변환 참고 스크립트
├── DEVELOPMENT_DEFINITION.md  # 개발정의서
├── ERROR_NOTE.md              # 중요 오류 및 검증 기록
└── README.md
```

## 환경 구성

Python은 conda가 아니라 `uv` 기반 `.venv`를 사용합니다.

```bash
uv venv --python 3.11 .venv
uv pip install -e 'backend[dev]'
```

`backend/pyproject.toml`이 변경되면 같은 설치 명령으로 `.venv`를 업데이트합니다.

VLM 설정은 Home 화면에서 저장합니다. Save를 누르면 root `.env`가 자동 생성되며, 별도 환경 파일을 복사할 필요가 없습니다.

저장되는 주요 값:

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

Frontend는 기본적으로 `http://localhost:8000` backend를 사용합니다. 다른 backend 주소가 필요할 때만 실행 시점에 지정합니다.

```bash
VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

## LibreOffice

LibreOffice는 Python 패키지가 아니라 OS 레벨 앱/CLI입니다. Raw Data Extractor는 Office 문서의 PDF preview 생성을 위해 외부 `soffice` 명령을 호출합니다.

macOS 설치:

```bash
brew install --cask libreoffice
soffice --version
```

공식 설치 문서:

- https://www.libreoffice.org/download/download-libreoffice/
- https://www.libreoffice.org/get-help/install-howto/macos/

자동 탐색이 되지 않으면 Home 또는 `.env`에서 경로를 지정합니다.

```env
LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

## 실행

Backend와 frontend를 한 번에 실행합니다.

```bash
./scripts/run_dev.sh
```

기본 주소:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:5173`

Backend만 실행:

```bash
.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Frontend만 실행:

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev -- --host 127.0.0.1 --port 5173
```

## Raw Data Extractor

지원 포맷:

- `.docx`
- `.xlsx`
- `.pptx`
- `.pdf`

처리 흐름:

1. 원본 문서를 업로드합니다.
2. Backend가 `backend/storage/raw/{id}/original.ext`에 저장합니다.
3. Backend가 `preview.pdf`를 생성합니다.
4. Backend가 `content.html`을 생성합니다.
5. UI 좌측은 PDF preview, 우측은 HTML preview를 표시합니다.

업로드 옵션:

- `include_images`: 지원 가능한 이미지를 HTML에 data URL로 포함합니다.
- `include_formulas`: XLSX cell formula와 DOCX/PPTX Office Math 텍스트를 포함합니다.

Parser 전략:

- `.docx`: `mammoth` semantic HTML, 선택적 image data URI, 선택적 OOXML math 추출, `bleach` sanitize
- `.xlsx`: `openpyxl` read-only sheet table, 선택적 `data_only=False` formula 렌더링, 선택적 `xl/media/` 이미지 포함
- `.pptx`: `python-pptx` slide text/table/image 추출, 선택적 OOXML math 추출
- `.pdf`: PyMuPDF page text block 추출, 선택적 page image 추출

Raw API:

- `POST /api/raw-extractions`
- `GET /api/raw-extractions?limit=20`
- `GET /api/raw-extractions/{id}`
- `GET /api/raw-extractions/{id}/pdf`
- `GET /api/raw-extractions/{id}/html`

## Key Information Extractor

Home 화면에서 진입합니다.

주요 API:

- `GET /api/health`
- `GET /api/system/status`
- `GET /api/settings/vlm`
- `PUT /api/settings/vlm`
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

로컬 데모에서 실제 VLM 호출을 피하려면 Home 설정 대신 root `.env`에 아래 값을 둘 수 있습니다.

```env
VLM_PROVIDER=mock
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

Backend 테스트는 Office 파일의 LibreOffice 변환을 mock 처리합니다. 실제 LibreOffice PDF 변환은 로컬 smoke test로 확인합니다.

## 운영 메모

- SQLite DB 기본 파일명은 `backend/digitize_documents.db`입니다.
- 업로드 문서와 raw extraction 결과는 `backend/storage/` 아래에 저장됩니다.
- `.env`, `.venv`, local DB, storage output, `node_modules`, frontend build artifact는 git에서 제외됩니다.
- OCR과 Intelligence Parse는 UI에 비활성 카드로 표시되며 아직 구현 범위가 아닙니다.
