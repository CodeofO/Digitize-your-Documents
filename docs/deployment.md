# External Hosting Guide

현재 권장 구조는 **frontend 정적 호스팅 + backend API 분리 배포**다. 초기 외부 베타는 로그인 대신 관리자 공유 접근 코드로 제한하고, 업로드 문서/결과는 local persistent volume에 저장한 뒤 하루 단위 retention cleanup으로 삭제한다.

## 배포 구조

- Frontend: Vite static build를 정적 호스팅/CDN에 배포한다.
- Backend: FastAPI container를 API 서버로 배포한다.
- Database: 외부 호스팅은 Postgres를 권장한다. 로컬 개발은 SQLite를 계속 쓴다.
- Storage: 지금은 `STORAGE_BACKEND=local`과 persistent volume을 사용한다. S3 호환 스토리지 전환용 env와 storage adapter는 준비되어 있다.
- TLS/DNS: frontend와 backend 모두 HTTPS 뒤에서 실행한다. 예: `https://app.example.com`, `https://api.example.com`.

## Frontend

```bash
cd frontend
npm ci
VITE_API_BASE_URL=https://api.example.com npm run build
```

`frontend/dist`를 정적 호스팅에 올린다. 같은 build artifact를 여러 환경에서 재사용하려면 배포 단계에서 `config.js`만 교체한다.

```js
window.__DIGITIZE_CONFIG__ = window.__DIGITIZE_CONFIG__ || {};
window.__DIGITIZE_CONFIG__.API_BASE_URL = "https://api.example.com";
```

공유 접근 링크는 query string이 아니라 fragment를 사용한다.

```text
https://app.example.com/#access=<APP_ACCESS_SECRET>
```

프론트는 이 값을 `/api/auth/session`으로 교환한 뒤 URL에서 제거한다.

## Backend

```bash
cp backend/.env.production.example backend/.env.production
# backend/.env.production 값을 실제 secret/domain/storage 경로로 수정

docker compose -f docker-compose.hosting.example.yml up -d postgres
docker compose -f docker-compose.hosting.example.yml run --rm backend alembic upgrade head
docker compose -f docker-compose.hosting.example.yml up -d backend
```

핵심 env:

| 변수 | 권장값/설명 |
| --- | --- |
| `APP_ENV` | `production` |
| `ACCESS_CONTROL_MODE` | `shared_secret` |
| `APP_ACCESS_SECRET` | 공유 접근 코드. 길고 추측 불가능한 값으로 설정한다. |
| `SESSION_SECRET_KEY` | 세션 서명용 secret. 접근 코드와 별도 값 권장. |
| `SESSION_COOKIE_SECURE` | production에서는 `true` |
| `SESSION_COOKIE_SAMESITE` | 같은 site의 app/api면 `lax`, 완전 cross-site면 `none` + HTTPS 필수 |
| `CORS_ALLOWED_ORIGINS` | 정확한 frontend origin. 예: `https://app.example.com` |
| `DATABASE_URL` | `postgresql+psycopg://...` |
| `DATABASE_POOL_SIZE`, `DATABASE_MAX_OVERFLOW`, `DATABASE_POOL_TIMEOUT_SECONDS` | DB connection pool. 대량 workflow 실행 기본값은 최대 64 connection |
| `STORAGE_BACKEND` | 지금은 `local` |
| `DOCUMENT_STORAGE_DIR`, `RAW_STORAGE_DIR`, `PROCESSING_TMP_DIR` | persistent volume 하위 경로 |
| `UPLOAD_RETENTION_HOURS` | 외부 베타 기본 `24` |
| `UPLOAD_MAX_FILE_BYTES`, `UPLOAD_MAX_BATCH_FILES=10000`, `UPLOAD_MAX_PDF_PAGES`, `UPLOAD_MAX_IMAGE_PIXELS` | 업로드 남용 방지 제한 |
| `ALLOW_RUNTIME_SETTINGS` | production에서는 기본 `false` |
| `VLM_*` | VLM provider/model/API key |
| `VLM_MAX_CONCURRENT_REQUESTS` | 전체 모듈/워크플로우가 공유하는 VLM 동시 요청 상한 |
| `KIE_FIELD_GROUP_SIZE` | KIE에서 한 VLM 요청에 묶을 field 수 |

`STORAGE_BACKEND=local`에서는 `/data` 같은 persistent volume이 반드시 필요하다. volume이 없는 ephemeral filesystem에 두면 재배포 시 업로드와 결과가 사라진다.

비동기 export artifact는 local storage 기준 `DOCUMENT_STORAGE_DIR/exports/<export_job_id>/` 아래에 저장된다. `STORAGE_BACKEND=s3`에서는 같은 key prefix가 object storage로 업로드되고 DB에는 `s3://...` reference가 남는다. API polling에는 `ExportJob.status`, `size_bytes`, `error_message`가 노출되므로 운영 로그와 함께 export 실패율과 평균 생성 시간을 추적할 수 있다.

## 보안 동작

- `/api/health`, `/api/auth/session`, `/api/auth/logout` 외 `/api/*`는 세션이 필요하다.
- 세션은 HttpOnly cookie로 저장되고, mutating request는 `X-CSRF-Token`이 필요하다.
- 업로드는 확장자, file signature, 크기, PDF page 수, 이미지 pixel 수를 검사한다.
- 문서 원본과 page image는 public URL로 직접 노출하지 않고 API를 통해 반환한다.
- production에서 `/api/settings/vlm` 쓰기는 `ALLOW_RUNTIME_SETTINGS=true`가 아니면 차단된다.
- 보안 헤더는 `SECURITY_HEADERS_ENABLED=true`일 때 API/backend-served frontend 응답에 적용된다.

## 하루 단위 삭제

외부 베타에서는 `UPLOAD_RETENTION_HOURS=24`를 설정한다. backend 시작 시 cleanup worker가 실행되고 `RETENTION_CLEANUP_INTERVAL_SECONDS` 주기로 오래된 업로드 문서, raw extraction, batch/job/result, workflow run, audit event, 임시 schema를 삭제한다.

수동 실행도 가능하다.

```bash
curl -X POST https://api.example.com/api/maintenance/retention-cleanup \
  -H "X-CSRF-Token: <csrf-token>" \
  --cookie "digitize_session=<session-cookie>"
```

스키마, 분류기, 체크리스트, 워크플로우 정의, export preset은 retention cleanup 대상이 아니다. export job 기록과 생성 artifact는 업로드 데이터 보존 기간을 넘으면 cleanup 대상이다.

## S3 전환 준비

S3/R2/MinIO 계정과 bucket이 준비되면 아래 env를 설정하고 `STORAGE_BACKEND=s3`로 전환한다.

```env
STORAGE_BACKEND=s3
OBJECT_STORAGE_ENDPOINT_URL=
OBJECT_STORAGE_REGION=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ACCESS_KEY_ID=
OBJECT_STORAGE_SECRET_ACCESS_KEY=
OBJECT_STORAGE_FORCE_PATH_STYLE=false
OBJECT_STORAGE_PREFIX=
```

초기 베타에서는 S3 키가 없어도 된다. local persistent volume으로 운영하고, 데이터가 더 중요해지면 S3 호환 storage로 옮긴다.

## 운영 체크리스트

- DNS와 HTTPS 인증서를 먼저 준비한다.
- `APP_ACCESS_SECRET`, `SESSION_SECRET_KEY`, `VLM_API_KEY`, DB password는 repository에 커밋하지 않는다.
- `CORS_ALLOWED_ORIGINS`는 wildcard가 아니라 실제 frontend origin만 넣는다.
- reverse proxy는 request body size를 `UPLOAD_MAX_FILE_BYTES` 이상으로 맞추되 과도하게 크게 열지 않는다.
- Postgres와 `/data` volume은 백업한다. 단, 업로드 문서는 하루 삭제 정책과 개인정보 정책을 함께 확인한다.
- 로그에는 API key, 접근 코드, 원문 파일 내용이 남지 않게 한다.
- 배포 전 `npm run build`, backend pytest, `alembic upgrade head`, container health check를 통과시킨다.
