# 오류 기록

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
