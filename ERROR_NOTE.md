# 오류 기록

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
