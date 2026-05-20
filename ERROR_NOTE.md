# 오류 기록

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
- Dev HMR은 이전 Vite blank screen 수정 이후 안정성을 위해 비활성 상태를 유지한다.

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
- MVP 검증 중 React Refresh/Babel 정지 경로를 피하기 위해 `frontend/vite.config.ts`에서 Vite dev HMR을 비활성화했다.

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

- Dev HMR은 현재 안정성을 위해 꺼져 있다.
- Hot reload가 필요하면 먼저 최신 Vite/plugin-react/lucide 조합으로 재검증한 뒤 `server.hmr`을 다시 켠다.
