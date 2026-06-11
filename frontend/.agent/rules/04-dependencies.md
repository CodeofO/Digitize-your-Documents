# Rule 04 — 의존성 버전 고정 규칙

## 핵심 원칙

> **`TECHSTACK.md`와 이 파일이 버전의 절대 기준입니다.**
> AI 에이전트는 패키지 설치 시 반드시 아래 버전을 사용해야 합니다.
> 목록에 없는 패키지를 설치해야 할 경우, 먼저 사용자에게 확인하세요.

---

## @genai/ui GitLab Package Registry 설정

`.npmrc`가 레포 루트에 이미 설정되어 있습니다.

```ini
@genai:registry=http://server.interxlab.io:30000/api/v4/projects/430/packages/npm/
//server.interxlab.io:30000/api/v4/projects/430/packages/npm/:_authToken=...
```

> `.npmrc`를 수정하지 않습니다. 이미 설정된 파일을 그대로 사용합니다.

설치 실패 시:
```bash
pnpm ping --registry http://server.interxlab.io:30000/api/v4/packages/npm/
```

---

## 기본 설치 패키지 (보일러플레이트에 이미 포함)

```json
{
  "dependencies": {
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "@genai/ui": "^0.1.1"
  },
  "devDependencies": {
    "typescript": "~6.0.2",
    "vite": "^8.0.12",
    "@vitejs/plugin-react": "^6.0.1",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "tailwindcss": "^3.4.19",
    "@tailwindcss/typography": "^0.5.19",
    "eslint": "^9.39.4",
    "prettier": "^3.8.3"
  }
}
```

---

## 선택 설치 패키지 (필요 시)

### 서버 상태 관리

```bash
pnpm add @tanstack/react-query
pnpm add -D @tanstack/react-query-devtools
```

```json
{
  "@tanstack/react-query": "^5.80.7"
}
```

### 폼 관리 및 유효성 검사

```bash
pnpm add react-hook-form zod @hookform/resolvers
```

```json
{
  "react-hook-form": "^7.62.0",
  "zod": "^4.1.8"
}
```

### HTTP 클라이언트

```bash
pnpm add axios
```

### 날짜 처리

```bash
pnpm add dayjs
```

### 국제화

> **사용자가 명시적으로 다국어를 요청한 경우에만 설치합니다.**
> `src/i18n/` 폴더 구조는 항상 템플릿 그대로 유지합니다.

```bash
pnpm add i18next react-i18next
```

```json
{
  "i18next": "^21.6.14",
  "react-i18next": "^11.16.2"
}
```

### 데이터 시각화

```bash
pnpm add chart.js react-chartjs-2
```

### 테스트 (Vitest)

> 보일러플레이트에 테스트 도구는 기본 포함되어 있지 않습니다. 구현 단계에서 아래 버전으로 설치합니다.
> **`vitest`는 `^2.0.0`으로 고정합니다 (vite 5.x 호환).** 임의로 상위 버전을 설치하지 않습니다.

```bash
pnpm add -D vitest@^2.0.0 @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

```json
{
  "vitest": "^2.0.0"
}
```

> 동반 설치하는 `@testing-library/*`, `jsdom`은 `vitest 2.x`와 호환되는 버전으로 설치합니다.

---

## 클라이언트 상태 관리

클라이언트 상태는 **React Context API**를 사용합니다.

복잡한 전역 UI 상태(Context로 해결 안 될 때만) → Zustand 허용

```bash
pnpm add zustand
```

> 서버 상태는 TanStack Query, 전역 UI 상태는 Context API, 폼 상태는 React Hook Form.
> 역할 중복 설치 금지.

---

## 설치 규칙

```bash
# ✅ 올바른 방법
pnpm add react-hook-form@^7.62.0 zod@^4.1.8

# ❌ 잘못된 방법 — npm 사용 금지
npm install react-hook-form

# ❌ 잘못된 방법 — 버전 미지정
pnpm add react-hook-form
```

설치 전 기설치 여부 확인:
```bash
pnpm list {패키지명}
```

---

## 금지 패키지

| 패키지 | 대안 | 이유 |
|--------|------|------|
| moment | dayjs | 번들 사이즈 |
| lodash | 네이티브 JS 또는 lodash-es | 트리쉐이킹 미지원 |
| styled-components | Tailwind CSS | SaaS 레포 미사용 |
| enzyme | @testing-library/react | 레거시 |

---

## 버전 마이그레이션 정책

> **마이그레이션은 AI가 임의로 진행하지 않습니다.**

### 원칙

이 보일러플레이트의 의존성 버전은 **Gen.AI SaaS 레포와의 이식 호환성**을 기준으로 고정되어 있습니다.
버전을 올리면 PoC 코드를 SaaS로 이식할 때 버전 불일치가 발생할 수 있습니다.

### 금지 행동

```
❌ package.json의 버전을 임의로 올리는 행위
❌ 사용자 확인 없이 major/minor 버전 업그레이드 진행
❌ "최신 버전이 있습니다"라는 이유만으로 업그레이드 제안
❌ pnpm update --latest 또는 동등한 명령어 실행
```

### 마이그레이션이 필요한 경우 절차

마이그레이션이 불가피한 상황(보안 취약점, 필수 기능 부재 등)이라면 반드시 아래 순서를 따릅니다.

```
1. 업그레이드가 필요한 이유를 사용자에게 명확히 설명
2. 영향받는 패키지와 버전 목록 제시
3. 아래 경고 메시지 출력
4. 사용자 명시적 승인 후에만 진행
5. 이 파일(04-dependencies.md)의 버전 목록 업데이트
```

### 마이그레이션 요청 시 경고 메시지

```
⚠️  버전 마이그레이션 경고

업그레이드 대상: {패키지명} {현재 버전} → {새 버전}
이유: {업그레이드가 필요한 이유}

주의: 이 보일러플레이트는 Gen.AI SaaS 레포와의 이식 호환성을 위해
버전이 고정되어 있습니다. 마이그레이션 후 PoC 코드를 SaaS로
이식할 때 버전 불일치가 발생할 수 있어 권장하지 않습니다.

진행하시겠습니까? (예/아니오)
```

### 주요 패키지별 마이그레이션 위험도

| 패키지 | 위험도 | 이유 |
|--------|--------|------|
| `react` / `react-dom` | 🔴 높음 | React 19 → 18 다운그레이드 불가, SaaS가 18 사용 시 충돌 |
| `react-router-dom` | 🔴 높음 | v7 → v6 API 변경 큼, SaaS 코드 전면 수정 필요 |
| `@genai/ui` | 🔴 높음 | 내부 패키지 버전 불일치 시 컴포넌트 API 변경 가능 |
| `tailwindcss` | 🟡 중간 | v4 config 방식이 v3와 완전히 다름 |
| `typescript` | 🟡 중간 | strict 옵션 변경으로 기존 코드 타입 오류 가능 |
| `vite` | 🟢 낮음 | 빌드 도구라 런타임 영향 없으나 config 변경 필요 |
