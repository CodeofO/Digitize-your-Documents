# API Shape

주요 API는 문서 보관함을 기준으로 구성되어 있습니다. 기존 multipart 업로드 API는 호환성과 업로드 이어가기를 위해 유지합니다.

| Area | Endpoint |
| --- | --- |
| System status | `GET /api/system/status` |
| Document library | `POST /api/library/uploads`, `GET /api/documents`, `GET /api/documents/ids`, `POST /api/documents/selection`, `POST /api/documents/delete`, `GET /api/library/tree`, `POST /api/library/folders`, `POST /api/library/copy`, `POST /api/library/move`, `DELETE /api/documents/{document_id}` |
| Workflow from library | `POST /api/workflows/{workflow_id}/runs/from-documents` |
| Workflow upload legacy | `POST /api/workflows/{workflow_id}/runs/init`, `POST /api/workflow-runs/{run_id}/items`, `POST /api/workflow-runs/{run_id}/start` |
| Workflow recovery | `POST /api/workflow-runs/{run_id}/discard`, `POST /api/workflow-runs/{run_id}/resume`, `POST /api/workflow-runs/{run_id}/pause`, `POST /api/workflow-runs/{run_id}/restart`, `POST /api/workflow-runs/{run_id}/retry-failed` |
| Workflow queue | `POST /api/workflow-runs/{run_id}/enqueue`, `POST /api/workflow-runs/{run_id}/cancel-waiting`, `POST /api/workflow-runs/{run_id}/start`, `DELETE /api/workflow-runs/{run_id}/queue-entry` |
| KIE from library | `POST /api/batches/from-documents` |
| Classification from library | `POST /api/classification-batches/from-documents` |
| Required check from library | `POST /api/required-field-check-batches/from-documents` |
| Legacy batch upload | `POST /api/batches/init`, `POST /api/batches/{batch_id}/items`, `POST /api/batches/{batch_id}/start` |
| Summary polling | `GET /api/workflow-runs/{run_id}/summary`, `GET /api/batches/{batch_id}/summary` 계열 |

## Notes

- 기존 단일 `/api/documents` multipart API는 호환성용으로 즉시 전처리 완료 계약을 유지합니다.
- 보관함 대량 업로드 API는 백그라운드 conversion queue를 사용합니다.
- 목록 polling은 summary endpoint를 사용하고, 상세 화면에서만 item/page payload를 가져오는 방향이 기본입니다.
- Workflow export는 CSV, JSON, XLSX 형식을 지원합니다.
