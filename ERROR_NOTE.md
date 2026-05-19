# Error Note

## 2026-05-19 - Service UX expansion verification note

### Scope
- Added provider status, document intelligence, schema templates, batch upload, archive search, review progress, export presets, and audit events.
- Added lightweight SQLite migrations in `init_db()` so existing local DB rows are preserved while new columns/tables are added.
- AI 추천 Schema는 field-level `display_name` 없이 문서 주 언어 기반 `key_name`을 추천하도록 유지했다.

### Issue Found During Verification
- 검증용 frontend를 기존 `5173` 대신 `5174`에 띄우자 backend CORS allowlist가 `5173/4173`만 허용해서 browser fetch가 차단되었다.
- Fix: `backend/app/main.py`에 localhost/127.0.0.1 임의 포트를 허용하는 `allow_origin_regex`를 추가했다.

### Verification
- `npm run build` passed.
- `.venv/bin/python -m pytest backend` passed with 10 tests.

### Notes
- Existing local SQLite data should remain usable, but production migration tooling is still intentionally out of MVP scope.
- Dev HMR remains disabled from the earlier Vite blank-screen fix.

## 2026-05-19 - Frontend dev server blank screen

### Symptom
- `http://127.0.0.1:5173/` opened, but the app screen did not render.
- Vite served `index.html`, but module requests such as `/src/main.tsx`, `/src/App.tsx`, and `/@vite/client` timed out.
- Playwright screenshot timed out while waiting for the page load.

### Impact
- The production build could pass, but local dev verification was blocked.
- The user-facing MVP screen was not visible from the expected frontend URL.

### Root Cause
- `lucide-react` was imported from the package root barrel in `frontend/src/App.tsx`.
- In this local environment, Vite dev mode plus React Refresh/Babel transform hung while transforming frontend modules.
- The hang made TSX module responses stall even though the Vite server itself was running.

### Fix
- Changed lucide imports in `frontend/src/App.tsx` from root barrel import to direct icon module imports.
- Added `frontend/src/lucide-icons.d.ts` so TypeScript accepts direct lucide icon module imports.
- Disabled Vite dev HMR in `frontend/vite.config.ts` to avoid the React Refresh/Babel hang path during MVP verification.

### Verification
- `npm run build` passed.
- `curl http://127.0.0.1:5173/` returned `index.html`.
- `curl http://127.0.0.1:5173/src/main.tsx` returned transformed module code.
- Playwright confirmed the first screen renders at `http://127.0.0.1:5173/`.
- Playwright E2E passed:
  - load recent document
  - AI recommend schema
  - save schema
  - run extraction
  - review result
  - filter review rows
  - click page link
- Mobile viewport render was also checked.

### Commands Used
```bash
cd frontend
npm run build
VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev -- --host 127.0.0.1 --port 5173 --force --clearScreen false
```

### Notes
- Dev HMR is currently off for stability.
- If hot reload is needed later, first test with a newer compatible Vite/plugin-react/lucide stack, then re-enable `server.hmr`.
