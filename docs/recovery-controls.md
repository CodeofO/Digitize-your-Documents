# Recovery Controls

문서 보관함 도입 이후 실행 제어의 기준은 “원본 문서는 보존하고, 실행/추론 상태만 제어한다”입니다. 원본 삭제는 문서 보관함에서만 수행합니다.

| Control | Behavior |
| --- | --- |
| `추론 일시중단` | 새 item 실행을 멈춥니다. 이미 provider로 나간 VLM 호출은 늦게 돌아오더라도 run generation과 item 상태를 확인한 뒤 저장 여부를 결정합니다. |
| `이어하기` | 일시중단된 run/batch의 남은 item을 다시 실행합니다. 업로드된 문서는 다시 업로드하지 않습니다. |
| `추론 중단` | 실행 기록과 보관함 문서는 남기고 현재 workflow inference만 취소합니다. |
| `실행 예약` | 현재 보관함 document id 묶음을 재사용하고, 현재 workflow snapshot을 `waiting` run으로 등록합니다. 앞선 run이 `completed`, `needs_review`, `completed_with_errors`가 되면 다음 대기 run을 자동 시작합니다. |
| `대기 삭제` | 아직 시작하지 않은 `waiting` run만 취소합니다. 공유 문서 payload는 삭제하지 않습니다. |
| `바로 실행` | 같은 실행 그룹에서 가장 앞선 `waiting` run에만 허용합니다. 뒤 순서 run은 순차 실행 정책 때문에 거부됩니다. |
| `실패 재시도` | 결과 상세 화면에서 실패한 문서만 다시 queue에 넣고, 성공한 문서는 그대로 보존합니다. |
| `업로드 이어가기` | 새로고침 등으로 끊긴 legacy upload에서 같은 원본을 재선택해 누락 파일만 등록합니다. |

## Execution Reservation Policy

- `실행 예약`은 업로드를 수행하지 않습니다.
- `waiting` run을 다시 예약하는 것은 차단합니다.
- 자동 진행은 `completed`, `completed_with_errors`, `needs_review`에서만 다음 waiting run으로 넘어갑니다.
- `failed`, `paused`, `canceled`에서는 자동 진행을 멈춥니다.
- 대기 삭제와 추론 중단은 원본 document payload를 삭제하지 않습니다.
