# KIE AI Review Prompt Hardening

작성일: 2026-05-24

## 배경

KIE 2차 AI 검수에서 `법정대리인성명` 같은 한글 성명 필드를 과하게 보정하는 사례가 있었다.

- `문어`를 `문이`로 변경
- 손글씨로 보이는 `성명`, `서명`을 placeholder로 판단해 빈 값으로 변경
- `에이리니`를 `에이린ㄴ`처럼 더 불안정한 값으로 변경

이 문제는 2차 judgement가 1차값 검증이 아니라 재추출처럼 동작하고, correction 결과를 그대로 최종값에 반영하면서 발생했다.

## 변경 방향

- judgement prompt는 기본 판단을 `correct`로 두도록 강화했다.
- `needs_correction`은 이미지가 1차값을 명확히 반박할 때만 반환하도록 명시했다.
- 손글씨가 애매하거나 여러 글자로 읽힐 수 있으면 1차값을 유지하도록 했다.
- placeholder/label 판정은 인쇄된 양식 문구이고 실제 입력칸에 손글씨가 없을 때로 제한했다.
- 입력칸 안에 손글씨로 쓰인 `성명`, `서명`, `법정` 같은 값은 임의로 삭제하지 않도록 명시했다.
- correction prompt는 새 값을 만들어내지 말고, 명확하지 않으면 1차값을 그대로 반환하도록 했다.

## 자동 반영 가드

prompt만으로 막기 어려운 보정 결과에 대해 backend에서 추가 방어를 적용한다.

- 1차값이 비어 있지 않은데 correction 값이 `null`이면 자동 반영하지 않는다.
- correction confidence가 `0.85` 미만이면 자동 반영하지 않는다.
- 짧은 한글 문자열에서 correction 값이 1차값과 크게 달라지면 자동 반영하지 않는다.

자동 반영하지 않은 경우 기존 1차값을 유지하고 field warning을 남긴다.

- `ai_correction_discarded_null`
- `ai_correction_low_confidence`
- `ai_correction_large_change`

이 경우 job은 실패하지 않고 `needs_review`로 남아 사용자가 검수할 수 있다.
