# Document Automation Workspace Improvement Plan

작성일: 2026-05-29

## 목적

현재 프로젝트는 문서 보관함, 단일 모듈 실행, 워크플로우 빌더, 실행 예약, 결과 검수까지 핵심 흐름이 연결되어 있다. 다음 단계의 목표는 기능을 더 늘리기 전에 **대량 처리 안정성, 상태 일관성, 검수 UX, 비즈니스 PoC 완성도**를 끌어올리는 것이다.

## 우선순위 요약

| 우선순위 | 작업 | 목표 |
| --- | --- | --- |
| P0 | 상태 머신과 실행 불변식 고정 | 실행/대기/중단/재개 로직이 흔들리지 않게 한다. |
| P0 | 대량 실행 안정성 검증 | 1k~10k 문서에서 멈춤, 순서 뒤섞임, 늦은 응답 저장 문제를 막는다. |
| P1 | 관측성 강화 | 왜 느린지, 어디서 대기 중인지 UI와 로그로 바로 확인한다. |
| P1 | 결과 검수 UX 고도화 | 사람이 검토해야 하는 문서만 빠르게 처리하게 만든다. |
| P1 | Export/보고서 안정화 | 대량 CSV/JSON/XLSX 산출을 안정적으로 제공한다. |
| P2 | 배포/운영 구조 정리 | Postgres, job queue, object storage 기준 운영 구조를 만든다. |
| P2 | 업무 템플릿/PoC 패키지 | 고객에게 바로 보여줄 수 있는 업종별 예시를 만든다. |

## 진행 기록

| 날짜 | 상태 | 항목 | 반영 내용 |
| --- | --- | --- | --- |
| 2026-05-29 | 완료 | Phase 2-4 실행 현황 타임라인 / Phase 2-6 조회 index | workflow run list/summary polling이 item `result_json`을 반복 로드하지 않도록 aggregate count read path로 변경하고, workflow run/item 조회 index와 회귀 테스트를 추가했다. |
| 2026-05-29 | 진행 중 | Phase 1-1 Workflow 상태 머신 정식화 | 이미 실행 중이거나 terminal 상태인 run의 `start`를 409로 차단하고, terminal run의 `discard`가 완료 상태를 `canceled`로 바꾸지 못하도록 차단했다. 프론트 버튼 노출 조건과 backend 회귀 테스트를 함께 반영했다. |
| 2026-05-29 | 부분 완료 | Phase 2-4 1k summary polling 검증 | 1,000개 workflow item run에서 summary counter, progress phase, VLM counter 필드, `result_json` 미로드를 검증하는 backend 회귀 테스트를 추가했다. |
| 2026-05-29 | 완료 | Phase 2-4 모듈 batch summary polling | KIE, Document Classifier, Required Field Checker batch summary와 lightweight list에 aggregate count read path를 추가하고, Home monitor가 item 목록 없이 최근 batch 현황을 가져오도록 변경했다. |
| 2026-05-29 | 완료 | Phase 3-8 Background export job | Workflow, KIE batch, Classification batch, Required Field Check batch export를 `ExportJob` 모델/API로 비동기 생성하고, job status, filename, content type, size, failure reason을 DB에 남기도록 추가했다. 직접 다운로드 endpoint는 동일 artifact builder를 재사용한다. |
| 2026-05-29 | 완료 | Phase 3-8 Export retry/history UX | `GET /api/export-jobs`와 failed job retry API를 추가하고, KIE/Workflow/Module 화면에서 최근 export 상태, 다운로드, 재시도를 확인할 수 있게 했다. |
| 2026-05-29 | 완료 | Phase 2-6 운영 DB migration | `export_jobs`와 workflow/batch summary 조회 index를 Alembic `0002` migration으로 고정하고, 임시 SQLite DB에서 `alembic upgrade head`를 검증했다. |
| 2026-05-29 | 완료 | Phase 1-1 Waiting run guard | queue 대기 중인 workflow run이 API 직접 호출로 `resume`/`pause`되어 순서 제어를 우회하지 못하도록 409 guard와 회귀 테스트를 추가했다. |
| 2026-05-29 | 완료 | Phase 2-5 Export worker 복구 | FastAPI background task에만 의존하지 않도록 export worker를 lifespan에 추가하고, 서버 재시작으로 남은 `running` export job을 `queued`로 복구해 처리하도록 했다. |

## Phase 1. 안정성 고정

### 1. Workflow 상태 머신 정식화

- `uploading`, `preprocessing`, `waiting`, `running`, `paused`, `completed`, `needs_review`, `completed_with_errors`, `failed`, `canceled` 상태 전이를 표로 고정한다.
- 백엔드에서 불가능한 전이를 409 또는 422로 차단한다.
- 프론트엔드는 백엔드 정책과 같은 버튼 노출 조건을 사용한다.

완료 기준:

- 같은 run이 동시에 `running`과 `waiting`처럼 모순된 상태로 보이지 않는다.
- `waiting` 재예약, 순서 무시 바로 실행, 취소된 run 저장 같은 케이스가 테스트로 차단된다.

### 2. 실행 예약/중단/재개 불변식 테스트

- `실행 예약`은 업로드를 절대 다시 수행하지 않고 기존 document id만 재사용한다.
- `대기 삭제`와 `추론 중단`은 원본 문서를 삭제하지 않는다.
- `추론 일시중단` 이후 늦게 돌아온 VLM 응답은 generation과 item 상태를 확인한 뒤 폐기한다.
- `completed`, `needs_review`, `completed_with_errors`에서만 다음 waiting run을 자동 시작한다.

완료 기준:

- backend workflow 관련 pytest에 위 케이스가 포함된다.
- 5개 문서, 931개 문서, 1000개 이상 문서 fixture 또는 mock load 테스트가 있다.

### 3. 비동기 실행 회귀 테스트

- `WORKFLOW_MAX_WORKERS`와 `VLM_MAX_CONCURRENT_REQUESTS`가 분리되어 동작하는지 테스트한다.
- fake VLM sleep/counter로 실제 AI in-flight가 설정값을 넘지 않는지 확인한다.
- local worker가 VLM await 동안 점유되지 않는지 확인한다.

완료 기준:

- `workflow_max_workers=2`, `vlm_max_concurrent_requests=8`에서 AI 요청이 2를 초과해도 로컬 worker deadlock이 발생하지 않는다.
- VLM timeout, 429, late response 처리 테스트가 있다.

## Phase 2. 대량 처리와 관측성

### 4. 실행 현황 타임라인

- run/item/job 단위로 등록 시간, 실제 시작 시간, 종료 시간, 업로드 시간, 추론 시간을 표준 표시한다.
- workflow run summary에 `queued`, `preprocessing`, `running`, `vlm_active`, `vlm_waiting`, `completed`, `needs_review`, `failed` count를 일관되게 제공한다.
- 실행 현황 정렬은 등록 또는 실행 순서 기준으로 흔들리지 않게 한다.

완료 기준:

- 사용자가 “왜 0%인지”, “AI 요청이 막혔는지”, “전처리 중인지”를 한 화면에서 구분할 수 있다.
- 1k 문서 run 목록 polling이 item 전체 payload를 반복 전송하지 않는다.

### 5. Background job queue 검토/도입

- 문서 변환, workflow inference, export를 FastAPI process 내부 thread에만 의존하지 않는 구조를 검토한다.
- 후보: Redis/RQ, Celery, Dramatiq, arq.
- 초기 도입은 문서 변환과 대량 export부터 분리한다.
- 현재 1차 조치로 export는 `ExportJob` DB 레코드와 FastAPI background task로 분리했다. 운영 queue 도입 시 같은 job 상태 계약을 유지한다.

완료 기준:

- 서버 재시작 시 진행 중 job 복구 또는 취소 정책이 문서화된다.
- job id, retry count, failure reason이 DB에 남는다.

### 6. Postgres 운영 기준 정리

- SQLite는 로컬 개발 기본값으로 유지한다.
- 대량 처리와 외부 PoC는 Postgres 기준으로 connection pool, transaction timeout, index를 정리한다.
- workflow_runs, workflow_run_items, documents, document_pages 조회 index를 점검한다.

완료 기준:

- 5k~10k 문서 기준 목록 조회와 summary polling이 안정적으로 동작한다.
- `DATABASE_POOL_SIZE`, `DATABASE_POOL_TIMEOUT_SECONDS` 권장값이 README 또는 운영 문서에 정리된다.

## Phase 3. 검수 UX와 결과 산출

### 7. 결과 검수 화면 고도화

- `검토 필요` 문서만 빠르게 순회하는 모드를 만든다.
- 키보드 단축키로 다음/이전 문서, 승인, 보류, 필드 수정 저장을 처리한다.
- KIE evidence를 이미지 preview 위에 highlight하거나, 최소한 field별 근거 위치/텍스트를 함께 표시한다.

완료 기준:

- 사람이 100개 검토 필요 문서를 마우스 이동 최소화로 처리할 수 있다.
- 수정한 field value와 원본 AI value가 분리되어 이력으로 남는다.

### 8. Export 안정화

- Export는 CSV/JSON/XLSX 선택형으로 통일한다.
- 대량 export는 background export job으로 만들고 완료 후 다운로드하게 한다.
- Export schema는 branch별 union-column 정책을 유지하되 빈 값/unknown/class path를 명확히 한다.
- 관측 필드: `status`, `started_at`, `completed_at`, `filename`, `content_type`, `size_bytes`, `error_message`, audit event `exported_async`.
- 최근 export history UI에서 완료 artifact 다운로드와 실패 job 재시도를 제공한다.

완료 기준:

- 1k 이상 문서 export가 브라우저 timeout 없이 완료된다.
- export 실패 시 실패 사유 표시가 가능하고, 재시도 UX를 추가할 수 있는 job id가 남는다.

### 9. 문서 보관함 UX 보강

- 전체 선택, 복사, 이동, 잘라내기, 붙여넣기, 삭제, ESC 해제 단축키를 안정화한다.
- 아이콘/목록 보기에서 선택 상태, drag/drop, 대량 작업 진행 알림을 일관되게 유지한다.
- 삭제는 항상 확인 팝업을 띄우고, 가능하면 휴지통/복구 정책을 추가한다.

완료 기준:

- 대량 선택 후 삭제/이동이 UI freeze 없이 진행된다.
- 작업 중 알림과 완료 toast가 본문 layout을 밀어내지 않는다.

## Phase 4. 비즈니스 PoC와 제품화

### 10. 업종별 워크플로우 템플릿

- 은행 서류 자동 분류 및 정보 추출 템플릿을 첫 대표 예시로 다듬는다.
- 보험 청구서, 계약서, 신청서, 행정 서류 템플릿을 추가 후보로 정리한다.
- 각 템플릿은 classifier, schema, checklist, workflow definition을 함께 제공한다.

완료 기준:

- 사용자가 샘플 문서와 템플릿만으로 10분 안에 PoC 결과를 볼 수 있다.
- README/카드뉴스/데모 영상에서 같은 대표 템플릿을 사용한다.

### 11. ROI 메시지와 리포트

- 처리 문서 수, 자동 완료 비율, 검토 필요 비율, 실패율, 평균 추론 시간, 사람이 수정한 필드 비율을 계산한다.
- PoC 결과 리포트에 “절감된 반복 작업”과 “검토가 필요한 문서”를 명확히 보여준다.

완료 기준:

- 고객에게 `문서 N장 중 자동 완료 X%, 검토 필요 Y%, 실패 Z%`를 바로 설명할 수 있다.
- 데모 후 결과 리포트를 export할 수 있다.

### 12. 보안/운영 상품화

- 문서 보존 기간, 원본 삭제, 로그 보관, 외부 AI 전송 여부를 설정과 문서에 명확히 한다.
- 공유 접근 코드 이후 SSO, 조직/팀, 권한, 감사 로그를 enterprise 후보로 둔다.
- local storage, S3/R2/MinIO, customer-managed storage 옵션을 정리한다.

완료 기준:

- 외부 PoC 전에 개인정보와 원본 문서 보관 정책을 설명할 수 있다.
- production hosting 문서에 보안 설정 체크리스트가 포함된다.

## 당장 시작할 작업

1. [부분 완료] Backend workflow 상태 전이 테스트 추가.
2. [부분 완료] 1k 문서 mock run으로 summary polling, 실행 현황 정렬, VLM counter를 검증.
3. [대기] 결과 검수 화면에서 `검토 필요` 중심 순회 UX 설계.
4. [완료] Export를 background job으로 분리할지 설계안 작성 및 1차 구현.
5. [대기] 은행서류 템플릿을 README, 카드뉴스, 데모 영상에서 일관되게 쓰도록 정리.

## 보류할 작업

- 신규 모듈 추가.
- 복잡한 권한/조직 관리.
- 자동 rate limit 탐지.
- 완전한 cloud storage migration.

위 항목은 안정성과 PoC 흐름이 고정된 뒤 진행한다.
