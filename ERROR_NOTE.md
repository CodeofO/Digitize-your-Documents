# 오류 기록

## 2026-05-25 - 문서 보관함 상태 메시지가 문서 영역을 밀어내는 문제

### 증상

- 삭제 후 `n개 문서의 원본을 삭제했습니다` 같은 완료 문구가 문서 목록 위 본문 공간을 계속 차지했다.
- 보관함이 목록 보기만 제공되어 대량 문서 탐색 시 Finder식 아이콘 보기로 빠르게 훑기 어려웠다.
- 선택 후 `Esc`로 빠르게 선택 해제하는 파일 관리자식 동작이 없었다.

### 수정

- 문서 영역을 넓히기 위해 보관함 좌측 폴더 column과 패널 높이/패딩을 조정했다.
- 목록 보기와 아이콘 보기 전환을 추가했다.
- 진행 중 상태는 우측 상단 spinner 알림으로, 완료/오류는 자동 fade-out toast로 표시한다.
- `Esc` 단축키로 현재 선택을 해제한다.

### 검증

- `npm run build --prefix frontend` 통과
- `git diff --check` 통과

## 2026-05-25 - 문서 보관함 선택 삭제 안전장치

### 배경

- 전체 선택 후 다수 문서를 삭제할 방법이 필요했다.
- 프론트에서 수천 개 문서를 개별 DELETE로 호출하면 중간 실패와 긴 대기 시간이 발생할 수 있다.

### 조치

- `POST /api/documents/delete` bulk 삭제 API를 추가했다.
- 삭제는 document row를 제거하지 않고 원본 payload와 page image를 삭제한 뒤 `status=deleted`로 표시한다.
- 보관함 UI에는 `선택 삭제` 버튼과 확인 팝업을 추가했다.
- `Delete`/`Backspace` 단축키도 같은 확인 팝업을 거치도록 했다.

### 검증

- bulk 삭제 후 page image 요청이 410을 반환하는 회귀 테스트를 추가했다.
- `.venv/bin/pytest backend/tests/test_api.py -q` 통과: `92 passed`

## 2026-05-25 - 문서 보관함 폴더 복사/이동 중 pending folder 중복 insert

### 증상

- 폴더 복사 또는 이동 테스트에서 `UNIQUE constraint failed: document_library_folders.path`가 발생했다.
- 같은 요청 안에서 `검수 copy`, `완료/검수 copy` 같은 폴더 path가 두 번 insert되었다.

### 영향

- 폴더 copy/move API가 500으로 실패할 수 있었다.
- 문서 row와 storage copy가 진행된 뒤 flush 단계에서 실패하므로 사용자에게는 보관함 조작이 불안정하게 보인다.

### 원인

- SQLAlchemy session의 `autoflush=False` 설정 때문에 아직 DB에 flush되지 않은 `DocumentLibraryFolder` pending row를 query로 찾지 못했다.
- 이동 중 기존 folder row의 path를 바꾼 dirty row도 query에는 이전 DB 값으로 보였다.

### 수정

- `_ensure_library_folder_records()`가 DB query만 보지 않고 `db.new`, `db.dirty`의 `DocumentLibraryFolder.path`도 함께 확인하도록 보강했다.
- 폴더 복사/이동 테스트에 명시적 폴더, 문서 복사, 폴더 복사, 폴더 이동, 원본 삭제 후 복사본 조회를 포함했다.

### 검증

- `.venv/bin/pytest backend/tests/test_api.py::test_document_library_select_copy_move_and_folder_operations -q` 통과
- `.venv/bin/pytest backend/tests/test_api.py -q` 통과: `92 passed`
- `npm run build --prefix frontend` 통과

## 2026-05-25 - 문서 보관함 전환 중 `/api/documents` 즉시 전처리 계약 회귀

### 증상

- 보관함 중심 구조를 도입하면서 `/api/documents` 단일 업로드도 `queued` 상태로 반환하도록 바뀌었다.
- 기존 backend API 테스트에서 이미지/PDF/Office 업로드 직후 `page_count == 1`과 `pages[0]`을 기대하는 항목들이 실패했다.
- 잘못된 이미지나 파일 크기 초과도 FastAPI `HTTPException`으로 변환되기 전에 `DocumentProcessingError`가 그대로 올라왔다.

### 영향

- 기존 KIE 단일 문서 업로드, schema 추천, 단일 job 생성 경로가 업로드 직후 page image를 사용할 수 없게 된다.
- 기존 테스트와 외부 호환 API 사용자는 `/api/documents` 응답 계약이 갑자기 바뀐 것으로 보게 된다.

### 원인

- 새 보관함 대량 업로드 API와 기존 단일 업로드 API를 같은 비동기 conversion path로 묶으려 했다.
- 하지만 `/api/documents`는 이미 “업로드 완료 응답 시 page preview 준비 완료”라는 동기 계약을 갖고 있었다.

### 수정

- `/api/documents`는 기존처럼 `_create_document_from_upload()`를 사용해 즉시 전처리 완료 후 반환하도록 복구했다.
- 새 비동기 변환 queue는 `/api/library/uploads`에만 적용했다.
- `/api/library/uploads`에서 `DocumentProcessingError`가 발생하면 status code를 유지해 HTTP 오류로 반환하도록 보강했다.

### 검증

- `.venv/bin/python -m compileall backend/app` 통과
- `.venv/bin/pytest backend/tests/test_api.py -q` 통과: `91 passed`
- `npm run build --prefix frontend` 통과
- `git diff --check` 통과

## 2026-05-25 - 문서 보관함과 변환 대기열 도입 시 동작 기준

### 배경

- 모듈/워크플로우마다 업로드 버튼과 전처리 흐름이 분산되어 있었다.
- 대량 문서에서는 업로드와 변환이 오래 걸리므로, 사용자는 업로드 중에도 다음 폴더/파일을 계속 추가하고 싶어 했다.

### 결정

- 신규 기본 흐름은 `문서 보관함 -> 변환 queue -> ready 문서 제공 -> 모듈/워크플로우 실행`이다.
- `queued/preprocessing` 문서를 실행 대상으로 선택하면 job/item은 `waiting_for_document`로 저장한다.
- 변환 worker가 문서를 `ready`로 바꾸면 관련 대기 job/item을 자동 활성화한다.
- 원본 삭제는 보관함 payload 삭제이며, 과거 결과와 실행 기록 row는 유지한다.

### 주의

- 보관함 upload queue는 in-process queue다. 운영에서 여러 backend worker/process를 띄우면 별도 queue/dispatcher가 필요하다.
- 기존 multipart batch API는 이어가기/호환용으로 남아 있으므로 당장 제거하면 안 된다.

## 2026-05-21 - Gemini API key가 OpenAI endpoint로 전달됨

### 증상

- Gemini API key(`AIza...`)와 Gemini model name을 설정한 뒤 batch extraction을 실행하면 401 오류가 발생했다.
- 오류 메시지는 OpenAI 쪽에서 `Incorrect API key provided: AIza...`로 반환되었다.

### 영향

- 사용자는 Gemini를 선택했다고 생각하지만 backend는 OpenAI-compatible client로 호출해 실제 추출이 실패했다.
- Batch status는 running/failed로 남고 결과 export까지 진행할 수 없었다.

### 원인

- 기존 구현은 `VLM_PROVIDER=openai`/`mock` 중심이었고, provider 값이 `openai`이면 무조건 LangChain `ChatOpenAI` 경로를 사용했다.
- `VLM_API_KEY` 값이 Gemini native key인지 확인하지 않아 `AIza...` key가 OpenAI endpoint로 전달되었다.

### 수정

- 기본 provider를 `auto`로 변경했다.
- `VLM_BASE_URL`이 있으면 OpenAI-compatible endpoint를 사용한다.
- `VLM_API_KEY`가 `AIza`로 시작하고 `VLM_BASE_URL`이 없으면 Google GenAI native Gemini 경로를 사용한다.
- Gemini native 경로는 `google-genai` SDK의 `models.generate_content`를 사용하고, `response_mime_type="application/json"`과 `response_json_schema`로 structured output을 강제한다.

### 검증

- `.venv/bin/python -m pytest backend/tests -q` 통과
- `npm run build` 통과
- `google-genai` import 및 `GenerateContentConfig(response_json_schema=...)` local smoke test 통과

## 2026-05-21 - 로컬 이동 후 Batch progress polling 지연

### 증상

- Batch extraction은 백엔드에서 병렬 worker로 진행되지만, UI progress bar가 즉시 갱신되지 않고 브라우저 새로고침 후에야 진행률이 올라간 것처럼 보였다.
- Batch sidebar에서 파일 수가 많을 때 항목 높이가 흔들리거나 겹쳐 보일 수 있었다.

### 영향

- 실제 extraction은 진행 중이어도 사용자는 멈춘 것으로 판단할 수 있었다.
- 파일이 많은 batch에서 sidebar 렌더링 비용과 레이아웃 흔들림이 체감 렉으로 보였다.

### 원인

- Frontend API helper가 동적 조회 API에 `cache: "no-store"`를 명시하지 않아 polling 요청이 stale response를 받을 여지가 있었다.
- Batch polling이 최근 batch 목록 전체를 반복 조회해 active batch 하나만 필요한 상황에서도 불필요한 payload를 받았다.
- Polling 실패 시 기존 batch 상태를 유지하지 않고 비울 수 있어, 일시적 fetch 실패가 polling 중단처럼 보일 수 있었다.
- Virtualized batch file list는 고정 row height를 가정하지만, 긴 filename 줄바꿈으로 실제 row height가 커지면 항목이 겹칠 수 있었다.

### 수정

- Frontend API helper에 `cache: "no-store"`를 적용했다.
- Active batch가 있을 때는 `/api/batches/{batch_id}`를 1초 간격으로 polling하고, 최근 목록 전체 조회를 줄였다.
- Polling 실패 시 현재 batch UI 상태를 유지하도록 변경했다.
- Batch file row를 고정 높이로 만들고 filename은 2줄까지만 보여 virtual list 높이 계산과 실제 DOM 높이를 맞췄다.
- SQLite 연결에 `busy_timeout`, WAL, `synchronous=NORMAL`을 적용해 batch worker write와 polling read가 겹칠 때의 잠금 대기를 줄였다.

### 검증

- `.venv/bin/python -m pytest backend/tests` 통과
- `npm run build` 통과
- 로컬 경로에서 FastAPI import 약 0.36초, frontend build 약 2.6초로 iCloud 경로 병목이 사라진 것을 확인했다.

## 2026-05-21 - Frontend build 중 중복 type package 자동 포함

### 증상

- `npm run build`의 `tsc --noEmit` 단계가 불안정하게 멈추거나 실패했다.
- 실패 시 `Cannot find type definition file for 'react 2'`, `node 2`, `babel__core 2` 같은 TypeScript 오류가 표시되었다.

### 영향

- 앱 런타임 기능과 직접 관련된 오류는 아니지만, 검증 단계에서 frontend build가 실패해 배포 가능 상태를 확인할 수 없었다.

### 원인

- iCloud 동기화 경로의 `frontend/node_modules/@types` 아래에 `react 2`, `node 2` 같은 중복 type package 디렉터리가 생겨 있었다.
- TypeScript가 기본 동작으로 모든 `@types` 패키지를 자동 포함하면서 잘못된 중복 디렉터리까지 type package로 해석했다.

### 수정

- `frontend/tsconfig.json`에 앱에서 필요한 type package만 명시했다.
- `frontend/tsconfig.node.json`에도 Vite config 검증에 필요한 `node` type만 명시했다.
- `lucide-react`는 공식 package entrypoint를 유지하고, dependency version을 exact pin으로 고정해 lockfile과 package manifest의 설치 기준을 맞췄다.

### 검증

- `npm run build` 통과

## 2026-05-21 - Batch 실행 중 DB connection pool 고갈

### 증상

- Batch upload 후 `배치 추출 준비 중` 상태에서 frontend에 `Failed to fetch`가 표시되었다.
- Backend log에 `/api/extraction-jobs/{job_id}`와 `/api/batches?limit=12` 요청이 500을 반환했다.
- 예외는 `sqlalchemy.exc.TimeoutError: QueuePool limit of size 5 overflow 10 reached`였다.

### 영향

- Batch worker가 많이 돌 때 polling API가 DB connection을 얻지 못해 review UI가 멈춘 것처럼 보였다.
- Batch 자체가 진행 중이어도 frontend는 최신 상태를 읽지 못해 사용자에게 실패처럼 보였다.

### 원인

- `.env`에 `BATCH_MAX_WORKERS="16"`이 설정되어 있었다.
- 기존 extraction worker는 document/schema/page 정보를 읽은 뒤 VLM 호출이 끝날 때까지 같은 SQLAlchemy session을 유지했다.
- FastAPI `BackgroundTasks` 실행 시 endpoint의 request session도 pool slot을 하나 들고 있을 수 있었다.
- 결과적으로 16개 worker session과 request/polling session이 겹쳐 SQLite QueuePool 한도 15개를 초과할 수 있었다.

### 수정

- Extraction worker를 `prepare -> VLM call -> save` 단계로 분리했다.
- `prepare` 단계에서 job/document/schema/page 정보를 plain snapshot으로 복사한 뒤 DB session을 닫는다.
- VLM 호출 중에는 DB connection을 들고 있지 않도록 변경했다.
- 결과 저장과 실패 저장은 별도 짧은 DB session으로 처리한다.
- `POST /api/extraction-jobs`, `POST /api/batches`는 response payload를 만든 뒤 request DB session을 닫고 background task를 등록한다.

### 검증

- `.venv/bin/python -m pytest backend/tests/test_api.py -k "extraction_releases_db_connection_during_vlm_call or batch" -vv` 통과
- `test_extraction_releases_db_connection_during_vlm_call`에서 VLM 호출 시점의 checked-out DB connection 수가 0임을 검증
- `test_batch_high_worker_count_does_not_exhaust_db_pool`에서 `BATCH_MAX_WORKERS=16`, 20개 파일 batch가 완료되고 `/api/batches` 조회가 200 OK임을 검증

## 2026-05-20 - 임시 우회 제거 및 개발환경 정식 복구

### 증상

- 이전 frontend 복구 과정에서 Vite React plugin과 HMR을 끈 상태가 남아 있었다.
- `.venv`에는 PyMuPDF/bleach package file이 불완전하게 설치되어 전체 backend test가 실패할 수 있었다.
- `run_dev.sh`는 frontend `node_modules`가 존재하기만 하면 불완전 설치를 감지하지 못했다.

### 영향

- React Fast Refresh/HMR 없는 개발환경은 실제 Vite React 개발환경과 달라져 이후 검증 신뢰도가 낮아질 수 있었다.
- raw extraction/PDF 관련 테스트와 기능이 local dependency 상태에 따라 실패할 수 있었다.
- 일부 패키지 파일이 빠진 `node_modules`가 남아도 dev server가 늦게 실패할 수 있었다.

### 원인

- 깨진 `node_modules`를 먼저 복구하지 않은 상태에서 Vite/lucide 문제를 코드 우회로 처리했다.
- 최신 PyMuPDF 설치본은 `pymupdf` import가 정상 경로인데, 코드와 테스트는 `fitz` import에만 의존했다.
- `.venv`의 `bleach` package에 `html5lib_shim.py` 같은 실제 source file이 빠져 있었다.

### 수정

- `npm ci`로 frontend dependencies를 lockfile 기준으로 재설치했다.
- `frontend/vite.config.ts`에 `@vitejs/plugin-react`와 기본 HMR을 복구했다.
- `backend/app`과 backend test에서 `pymupdf` 우선 import, `fitz` fallback으로 바꿨다.
- `uv pip install --reinstall pymupdf bleach`로 깨진 `.venv` package file을 복구했다.
- `run_dev.sh`에 backend 핵심 dependency check와 frontend package file completeness check를 추가했다.
- README와 개발정의서에 `npm ci`, PyMuPDF import 기준, 실행 전 의존성 점검 내용을 반영했다.

### 검증

- `.venv/bin/python -m pytest backend` 통과, 25개 테스트 기준
- `npm run build` 통과
- `./scripts/run_dev.sh`로 backend/frontend 동시 기동 확인
- `curl -I http://127.0.0.1:5173/` 200 OK
- `curl -I http://127.0.0.1:5173/src/App.tsx` 200 OK
- `curl -s http://127.0.0.1:8000/api/health` `{"status":"ok"}`
- Playwright screenshot 생성 성공: `/tmp/kie-dev-check-no-workaround.png`
- 검증 후 `8000`, `5173` listen process 없음

## 2026-05-20 - Vite/lucide frontend startup failure

### 증상

- `./scripts/run_dev.sh` 실행 시 backend는 뜨지만 frontend dev server가 Vite config 로딩 단계에서 실패했다.
- 에러 메시지는 `@vitejs/plugin-react/dist/index.js` default export를 찾지 못한다고 표시되었다.
- 별도 import 재현에서는 `@rolldown/pluginutils`가 `exactRegex` export를 제공하지 않는 오류도 확인되었다.
- Vite가 뜬 뒤에도 `lucide-react` icon file 일부를 resolve/read하지 못하는 에러가 이어졌다.

### 영향

- `http://127.0.0.1:5173` frontend가 시작되지 않았다.
- frontend 실패 후 Uvicorn reload child process가 남으면 다음 실행 때 `8000` port 충돌로 이어질 수 있었다.

### 원인

- `frontend/node_modules`의 `lucide-react` package가 일부 `.js` file 없이 `.map` file만 남은 불완전한 상태였다.
- 불완전한 `node_modules` 때문에 `@vitejs/plugin-react`와 transitive dependency import도 정상 검증되지 않았다.
- 기존 cleanup은 background parent process만 종료할 수 있어 Uvicorn reload child가 남을 여지가 있었다.

### 수정

- `npm ci`로 frontend dependencies를 깨끗하게 재설치했다.
- 임시로 제거했던 `@vitejs/plugin-react`와 HMR은 후속 정리에서 복구했다.
- lucide icon import를 package 내부 file path 대신 공식 `lucide-react` entrypoint named import로 변경했다.
- 더 이상 필요 없는 direct icon module declaration file을 제거했다.
- `scripts/run_dev.sh` cleanup을 process tree 종료 방식으로 보강했다.

### 검증

- `node -e "import('@vitejs/plugin-react')..."` 통과
- `npm ci` 이후 `node -e "import('lucide-react')..."` 통과
- `npm run build` 통과
- `./scripts/run_dev.sh`로 backend/frontend 동시 기동 확인
- `curl -I http://127.0.0.1:5173/` 200 OK
- `curl -I http://127.0.0.1:5173/src/App.tsx` 200 OK
- `curl -s http://127.0.0.1:8000/api/health` `{"status":"ok"}`
- Playwright screenshot 생성 성공: `/tmp/kie-dev-check-fixed.png`
- 검증 후 `8000`, `5173` listen process 없음

## 2026-05-20 - dev server `Address already in use`

### 증상

- `./scripts/run_dev.sh` 실행 시 backend 시작 로그 직후 `ERROR: [Errno 48] Address already in use`가 출력되었다.

### 영향

- 기존 backend process가 `127.0.0.1:8000`을 점유해 새 backend가 뜨지 못했다.
- frontend port `5173`은 비어 있었지만, backend 실패 메시지만 보이면 어느 포트가 문제인지 파악하기 어려웠다.

### 원인

- 이전 Uvicorn reload parent/child process가 종료되지 않고 남아 `8000` port를 점유했다.
- `run_dev.sh`가 port 사전 점검 없이 backend/frontend를 바로 실행해 충돌 원인을 명확히 보여주지 못했다.

### 수정

- 남아 있던 KIE backend process를 종료했다.
- `scripts/run_dev.sh`에 backend/frontend port 사전 점검을 추가했다.
- 포트가 사용 중이면 `lsof` 결과와 대체 port 실행 예시를 출력하고 시작 전에 종료하도록 했다.

### 검증

- `lsof -nP -iTCP:8000 -sTCP:LISTEN` 결과 없음
- `lsof -nP -iTCP:5173 -sTCP:LISTEN` 결과 없음

## 2026-05-20 - Excel CSV 한글 깨짐 및 로컬 의존성 검증 이슈

### 증상

- CSV export 파일을 Excel에서 바로 열면 한글 column/value가 깨져 보일 수 있었다.
- `.venv/bin/python -m pytest backend` 전체 실행 시 PDF/raw extraction 관련 테스트가 실패했다.

### 영향

- CSV export 자체는 UTF-8 문자열로 생성되지만, Excel이 BOM 없는 CSV를 시스템 기본 인코딩으로 해석하면 한글이 깨진다.
- 전체 backend 회귀 테스트는 현재 로컬 `.venv` 의존성 상태 때문에 완료되지 않는다.

### 원인

- CSV 응답에 UTF-8 BOM이 없고 `Content-Type`이 `text/csv`만 내려가 Excel 자동 감지가 불안정했다.
- 현재 `.venv`의 `fitz` module이 PyMuPDF API(`fitz.open`)를 제공하지 않는 package로 잡혀 있다.
- 현재 `.venv`에서 `bleach` import가 `html5lib_shim` circular import 오류로 실패한다.

### 수정

- 단일 extraction result CSV와 batch CSV export에 UTF-8 BOM을 붙였다.
- CSV 응답 `Content-Type`을 `text/csv; charset=utf-8`로 명시했다.
- CSV export 테스트에 BOM byte와 charset header 검증을 추가했다.

### 검증

- `.venv/bin/python -m pytest backend/tests/test_api.py -k batch_export_csv_and_json_mock_mode -vv` 통과
- `.venv/bin/python -m pytest backend/tests/test_api.py -k extraction_mock_mode_returns_evidence_and_normalized_values -vv` 통과
- 후속 조치로 `.venv`의 PyMuPDF/bleach를 재설치하고 `pymupdf` 우선 import로 변경해 `.venv/bin/python -m pytest backend` 통과 상태로 복구했다.

## 2026-05-20 - `.venv` 감시로 인한 backend reload loop 및 Batch 중단 부재

### 증상

- Backend가 시작 직후 `.venv/lib/python3.11/site-packages/openai/...` 파일 변경을 감지하며 반복적으로 reload되었다.
- 로그가 `Started server process` → `WatchFiles detected changes in '.venv/...'` → `Shutting down`을 반복했다.
- Batch extraction이 오래 걸릴 때 사용자가 작업을 중단할 수 있는 UI/API가 없었다.

### 영향

- 개발 서버가 안정적으로 떠 있지 못해 Batch progress polling과 background extraction이 정상 동작하기 어려웠다.
- FastAPI in-process background task가 reload에 의해 중단되거나, 이미 시작된 VLM 호출이 끝날 때까지 기다리는 상태가 발생할 수 있었다.
- 사용자는 잘못 시작한 batch를 멈추지 못했다.

### 원인

- 이전 `run_dev.sh`는 root에서 Uvicorn을 실행하면서 `--reload-dir`를 지정했지만, 실행 context와 기존 프로세스 상태에 따라 WatchFiles가 `.venv` 변경을 계속 감지할 수 있었다.
- OpenAI 패키지 또는 iCloud 동기화가 `.venv/site-packages` 파일 metadata를 갱신하면 reload 대상처럼 잡혔다.
- Batch는 생성/조회 API만 있고 cancel endpoint와 UI action이 없었다.

### 수정

- `run_dev.sh`를 `backend/` 디렉터리에서 실행하도록 변경하고, reload 감시 범위를 상대 경로 `app`으로 고정했다.
- Uvicorn에 `--reload-include "*.py"`와 `.venv`, frontend, storage, DB exclude rule을 추가했다.
- `POST /api/batches/{batch_id}/cancel` API를 추가했다.
- cancel 요청 시 queued/running job을 `canceled`로 표시하고, Batch response에 `canceled_count`를 포함하도록 했다.
- extraction worker가 이미 취소된 job은 시작하지 않고, VLM 호출 후에도 job 상태를 다시 확인해 취소된 job의 result 저장을 막도록 했다.
- Frontend Batch result row에 running/queued batch를 멈추는 `Stop` 버튼을 추가했다.

### 검증

- `bash -n scripts/run_dev.sh` 통과
- `npm run build` 통과
- `.venv/bin/python -m pytest backend` 통과, 20개 테스트 기준
- `git diff --check` 통과

## 2026-05-20 - Batch 진행률 미갱신 및 dev reload 재시작

### 증상

- Batch extraction 실행 후 popup의 progress bar가 자동으로 갱신되지 않았다.
- 서버 로그에 `GET /api/batches?limit=8` 이후 `WatchFiles detected changes in '.venv/bin/activate_this.py'. Reloading...`가 출력되었다.
- Uvicorn이 shutdown에 들어가며 `Waiting for background tasks to complete` 상태가 되었다.

### 영향

- 사용자는 배치 처리 진행률을 실시간으로 확인할 수 없었다.
- 개발 서버가 `.venv` 변경을 backend code 변경으로 오인해 reload하면서, in-process `BackgroundTasks` 기반 extraction 작업이 중단되거나 지연될 수 있었다.

### 원인

- Frontend Batch popup은 batch 생성 직후와 수동 Refresh 때만 `/api/batches`를 호출했고, running batch에 대한 polling이 없었다.
- `scripts/run_dev.sh`의 backend 실행이 `uvicorn --reload`만 사용해 프로젝트 root 전체를 감시했다.
- root 전체 감시에는 `.venv`, storage, DB 같은 runtime artifact가 포함되어 개발 중 파일 변경이 backend reload로 이어질 수 있었다.

### 수정

- Batch popup이 열려 있고 running/queued batch item이 있으면 1.5초 간격으로 `/api/batches?limit=8`을 polling하도록 수정했다.
- Batch popup을 열 때도 최신 batch 상태를 즉시 refresh하도록 수정했다.
- `scripts/run_dev.sh`에서 Uvicorn reload 감시 범위를 `backend/app`으로 제한해 `.venv`, `backend/storage`, local DB 변경이 reload를 유발하지 않도록 했다.

### 검증

- `bash -n scripts/run_dev.sh` 통과
- `npm run build` 통과
- `.venv/bin/python -m pytest backend` 통과, 19개 테스트 기준
- `git diff --check` 통과

## 2026-05-19 - 서비스 UX 확장 검증 기록

### 범위

- Provider 상태, 문서 인텔리전스, schema template, batch upload, archive search, review progress, export preset, audit event를 추가했다.
- 기존 로컬 SQLite row를 유지하면서 새 column/table을 추가할 수 있도록 `init_db()`에 경량 migration을 추가했다.
- AI 추천 schema는 field-level `display_name` 없이 문서 주 언어 기반 `key_name`을 추천하도록 유지했다.

### 검증 중 발견한 이슈

- 검증용 frontend를 기존 `5173` 대신 `5174`에 띄우자 backend CORS allowlist가 `5173/4173`만 허용해 browser fetch가 차단되었다.
- 수정: `backend/app/main.py`에 localhost/127.0.0.1 임의 포트를 허용하는 `allow_origin_regex`를 추가했다.

### 검증

- `npm run build` 통과
- `.venv/bin/python -m pytest backend` 통과, 당시 10개 테스트 기준

### 메모

- 기존 로컬 SQLite data는 유지되어야 한다.
- 운영 migration tooling은 현재 MVP 범위에서 제외한다.
- Dev HMR은 후속 정리에서 `@vitejs/plugin-react`와 함께 복구했다.

## 2026-05-19 - Frontend dev server blank screen

### 증상

- `http://127.0.0.1:5173/`는 열렸지만 app 화면이 렌더링되지 않았다.
- Vite는 `index.html`을 제공했지만 `/src/main.tsx`, `/src/App.tsx`, `/@vite/client` 같은 module request가 timeout 되었다.
- Playwright screenshot도 page load 대기 중 timeout 되었다.

### 영향

- Production build는 통과할 수 있었지만 local dev 검증이 막혔다.
- 사용자가 확인해야 하는 MVP 첫 화면이 예상 frontend URL에서 보이지 않았다.

### 원인

- `frontend/src/App.tsx`가 `lucide-react` package root barrel에서 icon을 import하고 있었다.
- 이 로컬 환경에서는 Vite dev mode와 React Refresh/Babel transform 조합이 frontend module transform 중 멈췄다.
- Vite server 자체는 떠 있었지만 TSX module response가 정지되었다.

### 수정

- `frontend/src/App.tsx`의 lucide import를 root barrel import에서 icon별 direct module import로 변경했다.
- TypeScript가 direct lucide icon module import를 허용하도록 `frontend/src/lucide-icons.d.ts`를 추가했다.
- MVP 검증 중 React Refresh/Babel 정지 경로를 피하기 위해 당시에는 `frontend/vite.config.ts`에서 Vite dev HMR을 비활성화했다.
- 후속 정리에서 `npm ci`로 깨진 dependency를 복구한 뒤 React plugin과 HMR을 다시 켰다.

### 검증

- `npm run build` 통과
- `curl http://127.0.0.1:5173/`가 `index.html` 반환
- `curl http://127.0.0.1:5173/src/main.tsx`가 변환된 module code 반환
- Playwright로 첫 화면 렌더링 확인
- Playwright E2E로 아래 흐름 확인:
  - recent document load
  - AI schema recommendation
  - schema save
  - extraction run
  - result review
  - review row filter
  - page link click
- Mobile viewport render도 확인했다.

### 사용 명령

```bash
cd frontend
npm run build
VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev -- --host 127.0.0.1 --port 5173 --force --clearScreen false
```

### 메모

- Dev HMR은 후속 정리에서 복구했다.
