# Toss Design Benchmark

이 문서는 `Document Automation Workspace`의 UI 톤을 정리하기 위해 Toss Design System 문서를 벤치마크한 기록이다. 공식 TDS UI Kit, 패키지, 컴포넌트, 브랜드 자산을 포함하거나 재배포하지 않고, 공개 문서에서 확인한 디자인 방향을 자체 CSS와 React 컴포넌트로 해석해 적용한다.

## 참고 문서

- [앱인토스 개발자센터 - 토스 디자인 시스템 (TDS)](https://developers-apps-in-toss.toss.im/design/components.html)
- [앱인토스 개발자센터 - 피그마/TDS Mobile UI Kit 라이선스](https://developers-apps-in-toss.toss.im/design/prepare/figma-ui-license.html)
- [TDS Mobile - 소개](https://tossmini-docs.toss.im/tds-mobile/)
- [TDS Mobile - Colors](https://tossmini-docs.toss.im/tds-mobile/foundation/colors/)
- [TDS Mobile - Typography](https://tossmini-docs.toss.im/tds-mobile/foundation/typography/)
- [TDS Mobile - Button](https://tossmini-docs.toss.im/tds-mobile/components/button/)
- [TDS Mobile - Badge](https://tossmini-docs.toss.im/tds-mobile/components/badge/)
- [TDS Mobile - Progress Bar](https://tossmini-docs.toss.im/tds-mobile/components/progress-bar/)
- [TDS Mobile - Modal](https://tossmini-docs.toss.im/tds-mobile/components/modal/)
- [TDS Mobile - Segmented Control](https://tossmini-docs.toss.im/tds-mobile/components/segmented-control/)

## 벤치마크 요약

TDS는 제품 전반에서 공통 디자인 언어를 유지하고, 개발과 디자인이 같은 기준으로 협업하는 것을 목표로 한다. 우리 UI에는 이 방향을 다음 기준으로 반영한다.

| 항목 | 벤치마크 내용 | 적용 방향 |
| --- | --- | --- |
| Colors | Grey surface와 blue primary를 중심으로 상태를 구분한다. | 배경과 패널은 `grey50~200`, 주요 액션은 `blue500`, hover는 `blue600`을 사용한다. |
| Typography | 텍스트 계층을 토큰처럼 다루고, 과도한 장식보다 정보 위계를 우선한다. | 제목, 섹션 라벨, 보조 설명을 크기와 굵기로 구분하고 letter spacing은 0으로 유지한다. |
| Button | `fill`은 주요 액션, `weak`은 보조 액션에 적합하다. | 실행 버튼은 blue fill, 저장/갱신/결과 보기 등은 white/weak 버튼으로 둔다. |
| Badge | 상태를 빠르게 인식시키되 weak 스타일로 과한 강조를 줄일 수 있다. | 모델 상태 pill은 green 대신 blue weak 톤으로 정리한다. |
| Progress Bar | 진행률은 0~1 범위의 값과 blue 계열 progress로 명확히 보인다. | Workflow 실행 progress는 blue accent와 부드러운 transition을 유지한다. |
| Modal | 화면 위에 overlay와 content를 띄워 집중할 대상을 분리한다. | Workflow 결과 상세는 캔버스를 유지한 채 overlay modal로 표시한다. |
| Segmented/선택 UI | 선택 상태와 접근성 상태를 명확히 표현한다. | 선택된 rail item, active tab, active filter는 blue weak 배경과 blue border를 사용한다. |

## 현재 UI 점검

- Home: 간결한 landing 화면으로 정리하고, 핵심 가치 카드 3개와 primary CTA만 첫 화면에서 강조한다.
- Module Upload: 핵심 정보 추출, 문서 분류, 필수 항목 확인의 빈 업로드 영역에는 샘플 문서 preview를 배치해 사용자가 입력 예시를 바로 볼 수 있게 한다.
- Topbar: 모델 상태 pill은 TDS Badge의 weak 스타일처럼 낮은 채도의 blue 배경을 사용한다.
- Workflow Builder: 문서 업로드는 dashed weak affordance, 실행은 blue fill primary action으로 분리한다.
- Workflow Run: progress dock은 별도 레이아웃 공간을 밀어내지 않고 캔버스 위에 떠 있으며, 진행률은 blue bar로 표시한다.
- Result Modal: 캔버스는 뒤에 유지하고 overlay로 집중 영역을 만든다.
- Module Workspace: 단일/배치 실행 버튼은 primary action 역할이므로 blue fill 계열을 유지한다.

## 라이선스 메모

앱인토스 TDS UI Kit 라이선스는 UI Kit의 사용 범위와 재배포를 제한한다. 이 프로젝트는 공식 TDS UI Kit 파일, 컴포넌트 코드, 이미지, 로고, 브랜드 자산을 포함하지 않는다. README에는 “TDS를 사용했다”가 아니라 “TDS 문서를 벤치마크해 자체 구현했다”로 표기한다.
