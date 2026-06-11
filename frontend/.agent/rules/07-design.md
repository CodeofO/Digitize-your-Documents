# Rule 07 — 디자인 소스 및 Tailwind 설정

> **이 파일이 디자인의 단일 진실 공급원(Single Source of Truth)입니다.**
> 에이전트는 컴포넌트를 작성하기 전에 이 파일을 반드시 읽어야 합니다.
> 디자인 소스를 교체하려면 이 파일만 수정하면 됩니다.

---

## 현재 디자인 소스

```
PRIMARY_UI_PACKAGE = @genai/ui
```

| 항목 | 값 |
|------|-----|
| 기본 컴포넌트 패키지 | `@genai/ui` |
| 버전 | `^0.1.1` |
| Tailwind 프리셋 | `@genai/ui/tailwind-preset` (패키지 내 포함 시) |
| 대체 패키지 | 없음 (현재) |

---

## 디자인 소스 교체 방법

다른 팀 또는 프로젝트에서 디자인 소스를 교체할 때:

1. 위 `PRIMARY_UI_PACKAGE` 값을 변경한다
2. 아래 `tailwind.config.js` 설정을 새 패키지에 맞게 업데이트한다
3. `rules/04-dependencies.md`의 패키지 버전도 함께 업데이트한다

```
# 교체 예시
PRIMARY_UI_PACKAGE = @mui/material       ← MUI로 교체
PRIMARY_UI_PACKAGE = @shadcn/ui          ← shadcn으로 교체
PRIMARY_UI_PACKAGE = @my-team/ui         ← 팀 자체 패키지
PRIMARY_UI_PACKAGE = none                ← 패키지 없이 커스텀만 사용
```

---

## Tailwind 설정

**파일 위치:** `tailwind.config.js` (보일러플레이트에 이미 설정됨)

설정 내용은 레포 루트의 `tailwind.config.js`를 직접 참조합니다.

> CSS 변수(`--background`, `--primary` 등)는 `src/index.css`에 정의합니다.
> PRIMARY_UI_PACKAGE 교체 시 CSS 변수 값만 변경하면 됩니다.

---

## 에이전트 행동 규칙

> **기본 원칙: `@genai/ui` 활용을 기본으로 합니다.** UI는 먼저 `@genai/ui`로 구성하고, 패키지에 없는 것만 로컬로 만듭니다.

### 컴포넌트 작성 시

> **PRIMARY_UI_PACKAGE에 존재하는 재사용 컴포넌트는 의무 사용입니다.**
> 특정 컴포넌트(버튼/입력/모달)에 한정되지 않습니다. 패키지가 제공하는 **모든** 재사용 컴포넌트(탭, 셀렉트, 체크박스, 토스트, 테이블, 카드, 뱃지, 스피너, 툴팁 등)가 대상입니다.
> 존재하는 컴포넌트를 네이티브 태그로 직접 스타일링하거나 로컬로 재구현하지 않습니다.

```
1. PRIMARY_UI_PACKAGE가 제공하는 컴포넌트 목록을 먼저 확인한다
2. 있으면 → 패키지에서 import (의무). 새로 만들거나 재구현하지 않는다
3. 없으면 → src/shared/components/에 로컬 컴포넌트 생성
4. 로컬 컴포넌트는 Tailwind 유틸리티 클래스만 사용한다
```

### 주색상(Primary) 선택 시

> **사용자의 별도 요청이 없으면 주색상은 `@genai/ui`의 primary 색상을 따릅니다.**
> 레퍼런스 이미지(피그마/스크린샷/디자인 시안)의 색을 임의로 추출해 주색상으로 쓰지 않습니다.

```
1. 기본값: @genai/ui의 primary 토큰/클래스를 그대로 사용한다
2. 레퍼런스 이미지가 있어도 색상은 무시하고 @genai/ui primary를 유지한다 (레이아웃·구성 참고용)
3. 사용자가 "이 색으로", "브랜드 컬러 적용" 등 명시적으로 요청할 때만 커스텀 주색상을 적용한다
```

### 스타일 작성 시

```
✅ Tailwind 유틸리티 클래스 사용 (기본)
✅ Tailwind로 표현 불가한 속성 → 인라인 CSS style={{}} 허용
✅ 인라인 CSS가 많아져 분리 필요 시 → CSS Module (.module.css) 사용

❌ PRIMARY_UI_PACKAGE와 다른 디자인 시스템 혼용
❌ 전역 CSS 파일에 컴포넌트 전용 스타일 작성
```

**스타일 선택 기준:**

```
1순위: Tailwind 유틸리티 클래스
2순위: 인라인 CSS (Tailwind에 없는 속성)
3순위: CSS Module (인라인이 복잡해질 때)
```

### 기본 디자인 검증 (필수)

> `@genai/ui`를 사용한다고 끝이 아닙니다. 조합한 화면이 어색하지 않은지 **눈으로 확인**합니다.

구현 후 아래를 점검하고, 어색하면 Tailwind 유틸리티로 배경·여백·정렬을 보정합니다(디자인 토큰 범위 내).

```
- [ ] 카드/패널에 배경색·테두리·그림자 중 하나라도 있어 영역이 구분되는가 (배경 없이 떠 보이지 않는가)
- [ ] 요소 간 여백(padding/gap)이 일관되고, 답답하거나 휑하지 않은가
- [ ] 정렬이 맞는가 (좌우 들쭉날쭉·세로 정렬 깨짐 없음)
- [ ] 텍스트 대비가 충분한가 (연한 배경 위 연한 텍스트 등 가독성 저하 없음)
- [ ] 버튼/인터랙션 요소가 클릭 가능한 것으로 보이는가
```

### 디자인 소스가 `none`인 경우

`PRIMARY_UI_PACKAGE = none`이면 모든 컴포넌트를 `src/shared/components/`에 직접 구현합니다.
Tailwind config의 `theme.extend`에 프로젝트 전용 토큰을 정의합니다.

---

## 현재 등록된 디자인 토큰

> `PRIMARY_UI_PACKAGE`가 제공하는 토큰 목록입니다.
> 패키지 교체 시 이 섹션도 함께 업데이트합니다.

| 토큰 종류 | 참조 방법 | 비고 |
|-----------|-----------|------|
| 색상 | `@genai/ui` 패키지 내 CSS 변수 또는 Tailwind 클래스 | 패키지 문서 확인 |
| 타이포그래피 | `@genai/ui` 패키지 내 정의 | 패키지 문서 확인 |
| Spacing | Tailwind 기본값 | |
| 컴포넌트 | `import { Button, Modal, ... } from '@genai/ui'` | |

> `@genai/ui` 상세 컴포넌트 목록은 패키지 문서를 참조하세요.
> 패키지 내부를 직접 읽거나 수정하지 않습니다.
