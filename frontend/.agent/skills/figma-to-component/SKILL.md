---
name: figma-to-component
description: Figma URL의 노드를 React 컴포넌트로 구현한다. 구현 후 Figma 원본과 정합성을 2회 검증하여 px 단위 정합도를 반환한다. Figma URL이 주어지거나 "Figma 보고 만들어줘", "이 디자인 구현해줘" 요청 시 활성화.
---

# Figma → Component Skill

---

## Step 0 — 입력 파싱

Figma URL에서 추출합니다.

```
fileKey : URL의 /design/{fileKey}/ 부분
nodeId  : node-id= 값, - → : 변환 (예: 0-40522 → 0:40522)
```

---

## Step 1 — Figma 디자인 컨텍스트 수집

Figma MCP를 호출합니다.

```
mcp__plugin_figma_figma__get_design_context
  nodeId          : 변환된 노드 ID
  fileKey         : 추출한 파일 키
  clientFrameworks: "react"
  clientLanguages : "typescript"
```

인증 미완료 시 `mcp__plugin_figma_figma__authenticate` 먼저 실행합니다.

응답에 포함된 **스크린샷 이미지**를 Step 3 정합성 검증에 사용합니다.

---

## Step 2 — 컴포넌트 생성

### 파일 위치

```
src/components/{ComponentName}/{ComponentName}.tsx
src/components/{ComponentName}/index.ts
```

> `@genai/ui`에 동일한 컴포넌트가 있으면 새로 만들지 않습니다.
> `rules/07-design.md`의 `PRIMARY_UI_PACKAGE`를 먼저 확인합니다.

### 생성 규칙

```
- Figma data-node-id 어트리뷰트 제거
- absolute positioning 아티팩트 정리
- Tailwind 유틸리티 클래스만 사용 (인라인 style 금지)
- 색상/spacing 하드코딩 금지 → Tailwind 토큰 또는 CSS 변수 사용
- Props: className?, onClick?, children? 기본 포함
- any 타입 금지
```

### 아이콘/이미지 에셋 처리

응답 코드의 `const imgXxx = "https://www.figma.com/api/mcp/asset/..."` URL을 확인합니다.

```bash
mkdir -p public/assets

# SVG
curl -L "{asset-url}" -o public/assets/{icon-name}.svg

# PNG/WebP
curl -L "{asset-url}" -o public/assets/{image-name}.png
```

컴포넌트 상단에 경로 상수 선언:

```tsx
const ICON_SEARCH = '/assets/icon-search.svg'
```

> 이모지, 플레이스홀더 SVG, 텍스트 대체 사용 금지. 반드시 실제 에셋을 사용합니다.

### 컴포넌트 템플릿

```tsx
// src/components/{ComponentName}/{ComponentName}.tsx

interface {ComponentName}Props {
  className?: string
  onClick?: () => void
  children?: React.ReactNode
}

const {ComponentName} = ({ className = '', onClick, children }: {ComponentName}Props) => {
  return (
    <div className={className} onClick={onClick}>
      {children}
    </div>
  )
}

export default {ComponentName}
```

```ts
// index.ts
export { default as {ComponentName} } from './{ComponentName}'
export type { {ComponentName}Props } from './{ComponentName}'
```

---

## Step 3 — 정합성 검증 (2회 반복)

구현 후 Figma 원본 스크린샷과 렌더링 결과를 비교합니다. **2회 반복하며 매 회차마다 차이를 수정합니다.**

### 준비

```bash
pnpm dev &
sleep 3
```

브라우저 스크린샷 또는 Claude의 이미지 분석으로 렌더링 결과를 Figma 원본과 비교합니다.

### 회차별 검증 항목

**[픽셀 대조]** — px 단위로 측정

| 항목 | Figma | 현재 | 일치 |
|------|-------|------|------|
| width / height | {값}px | {값}px | ✅/❌ |
| padding | {값}px | {값}px | ✅/❌ |
| gap | {값}px | {값}px | ✅/❌ |
| border-radius | {값}px | {값}px | ✅/❌ |
| font-size | {값}px | {값}px | ✅/❌ |
| line-height | {값}px | {값}px | ✅/❌ |

**[색상]** — hex 단위로 측정

| 항목 | Figma | 현재 | 일치 |
|------|-------|------|------|
| 배경색 | #{hex} | #{hex} | ✅/❌ |
| 텍스트 색상 | #{hex} | #{hex} | ✅/❌ |
| 테두리 색상 | #{hex} | #{hex} | ✅/❌ |
| 아이콘 색상 | #{hex} | #{hex} | ✅/❌ |

**[속성]**

| 항목 | Figma | 현재 | 일치 |
|------|-------|------|------|
| font-weight | {값} | {값} | ✅/❌ |
| letter-spacing | {값}px | {값}px | ✅/❌ |
| box-shadow | {값} | {값} | ✅/❌ |
| 에셋 동일성 | - | - | ✅/❌ |

**[상태]**

| 상태 | Figma 정의 | 구현 | 일치 |
|------|-----------|------|------|
| Default | ✅ | ✅/❌ | ✅/❌ |
| Hover | ✅/미정의 | ✅/❌/미구현 | ✅/❌ |
| Active | ✅/미정의 | ✅/❌/미구현 | ✅/❌ |
| Disabled | ✅/미정의 | ✅/❌/미구현 | ✅/❌ |

### 회차별 보고 형식

```
[회차 N/2]
- [픽셀] {항목}: Figma={값}px / 현재={값}px → 차이 {N}px
- [색상] {항목}: Figma=#{hex} / 현재=#{hex}
- [속성] {항목}: Figma={값} / 현재={값}
수정: {파일명} {전} → {후}
```

### 종료 조건

2회 완료 또는: 픽셀 오차 ≤ 2px + 색상 완전 일치 + 속성 완전 일치

---

## 완료 보고

```
### Figma → Component 정합성 보고

| 항목 | 값 |
|------|----|
| 컴포넌트 | {ComponentName}.tsx |
| Figma 노드 | {nodeId} |
| 다운로드 에셋 | {N}개 |
| 정합성 검증 | 2회 완료 |

### 픽셀 정합도
| 항목 | Figma | 구현 | 오차 | 판정 |
|------|-------|------|------|------|
| width | {N}px | {N}px | {N}px | ✅/❌ |
| height | {N}px | {N}px | {N}px | ✅/❌ |
| padding | {N}px | {N}px | {N}px | ✅/❌ |
| border-radius | {N}px | {N}px | {N}px | ✅/❌ |
| font-size | {N}px | {N}px | {N}px | ✅/❌ |

### 색상 정합도
| 항목 | Figma | 구현 | 판정 |
|------|-------|------|------|
| 배경 | #{hex} | #{hex} | ✅/❌ |
| 텍스트 | #{hex} | #{hex} | ✅/❌ |
| 테두리 | #{hex} | #{hex} | ✅/❌ |

### 상태 체크
[Default ✅] [Hover ✅/❌/미정의] [Active ✅/❌/미정의] [Disabled ✅/❌/미정의]

### 잔여 차이
없음 | - {항목}: Figma={값} / 현재={값} (오차 {N}px)
```
