# Command: init-poc

> PoC 프로젝트를 초기화하는 절차서입니다.
> 이 보일러플레이트를 클론한 후 에이전트 구성을 추가하고 dev server까지 확인합니다.
> `plan-poc` command에서 Tech Spec 승인 후 자동으로 호출됩니다.

---

## 전제 조건

- [ ] Node.js >= v24.15.0 설치되어 있는가?
- [ ] pnpm >= 9.15.4 설치되어 있는가?
  ```bash
  node -v
  pnpm -v
  ```
- [ ] `docs/tech-specs/{feature-name}.spec.md`가 `approved` 상태인가?

---

## Step 1 — 보일러플레이트 확인

이 레포는 이미 보일러플레이트 구조를 포함합니다.
**Vite를 새로 설치하지 않습니다.** 기존 구조를 그대로 사용합니다.

```
/
├── src/                   ← React 앱 (이미 구성됨)
├── .npmrc                 ← @genai/ui registry 설정 (이미 구성됨)
├── tailwind.config.js     ← Tailwind 설정 (이미 구성됨)
├── vite.config.ts         ← Vite 설정 (이미 구성됨)
├── tsconfig.app.json      ← @/* alias 포함 (이미 구성됨)
└── TECHSTACK.md           ← 기술스택 가이드 (반드시 읽기)
```

- [ ] `TECHSTACK.md`를 읽었는가?
- [ ] `rules/01-project.md`의 폴더 구조를 확인했는가?

---

## Step 2 — 의존성 설치

```bash
pnpm install
```

- [ ] `node_modules`가 생성되었는가?
- [ ] `@genai/ui` 설치가 성공했는가?

**`@genai/ui` 설치 실패 시:**

`.npmrc`의 registry 주소와 토큰을 확인합니다.

```bash
pnpm ping --registry http://server.interxlab.io:30000/api/v4/packages/npm/
```

응답이 없으면 네트워크 또는 토큰 문제입니다. 사용자에게 알립니다.

---

## Step 3 — 환경변수 설정

`.env.local` 파일을 생성합니다.

```bash
touch .env.local
```

```ini
# .env.local
VITE_API_BASE_URL=
VITE_APP_ENV=development
```

> API URL은 `docs/refs/api/`의 명세를 참조합니다.
> 명세가 없으면 사용자에게 확인합니다.

- [ ] `.env.local`이 생성되었는가?
- [ ] `.gitignore`에 `.env.local`이 포함되어 있는가?

---

## Step 4 — features/_template 복사

PoC에서 구현할 feature 슬라이스를 템플릿으로부터 생성합니다.

```bash
cp -r src/features/_template src/features/{featureName}
```

Tech Spec의 구현 범위를 기반으로 필요한 feature만 생성합니다.

- [ ] `src/features/{featureName}/` 폴더가 생성되었는가?

> **다국어(i18n) 정책:**
> `src/i18n/` 폴더 구조는 보일러플레이트 템플릿 그대로 유지합니다.
> i18next 패키지는 설치하지 않습니다.
> 사용자가 다국어를 명시적으로 요청할 때만 `pnpm add i18next react-i18next`를 실행합니다.

---

## Step 5 — 공통 레이아웃 적용 여부 선택

> **HARD GATE — 건너뛰지 마세요.**
> 이 선택은 반드시 사용자에게 묻습니다. 사용자가 1/2 중 하나를 답하기 전까지 다음 Step으로 진행하지 않습니다.
> **보일러플레이트에 AppLayout이 이미 적용돼 있더라도** 그대로 쓰지 말고 의도를 묻습니다. "아니오"면 wrapper를 **제거**합니다.
> 기본값(AppLayout 적용)으로 임의 진행하지 않습니다 — 사용자가 직접 선택해야 합니다.
>
> **PoC 결과물은 사용자의 별도 요청이 없으면 `/` 라우트에서 기능을 바로 확인할 수 있어야 합니다.** (1번/2번 모두 PoC 페이지를 `/`에 둔다. `/feedback-board` 같은 별도 경로로 숨기지 않는다)

---
🟢 Chaebi: 공통 레이아웃(사이드바 + 헤더) 적용 여부를 선택해주세요.

        현재 보일러플레이트는 @genai/ui의 AppShell 기반 레이아웃을 제공합니다.

        1. 예 — AppLayout으로 전체 감싸기 (사이드바 + 헤더 포함)
        2. 아니오 — 레이아웃 없이 페이지만 (빈 화면에서 시작)

        어떻게 하시겠어요?

---

### 1번 선택 — AppLayout 적용 (기본값 유지)

`src/app/routes/index.tsx`의 `AppLayout` 구조를 유지합니다.

> **기존 route page를 덮어쓰며 개발합니다.**
> 메인 레이아웃을 쓰는 PoC는 새 라우트를 따로 만들지 않고, **기존 인덱스 라우트(`/`)의 `HomePage`를 PoC 페이지로 교체**합니다. (보일러플레이트 예시 페이지 위에 그대로 얹어 개발)

```tsx
// src/app/routes/index.tsx — index 라우트의 element를 PoC 페이지로 덮어쓰기
export const routes = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [{ index: true, element: <{Feature}Page /> }], // HomePage → PoC 페이지로 교체
  },
])
```

추가 페이지가 필요할 때만 children에 라우트를 더하고, `src/layouts/AppLayout.tsx`의 `navItems` 배열에 메뉴를 등록합니다.

#### 로고 텍스트 변경 (필수)

`src/layouts/AppLayout.tsx`의 `'Logo'` 텍스트(`logo`, `header.centerLogo` 2곳)를 **PoC 프로젝트명**으로 변경합니다.

```tsx
logo={<span className="text-lg font-bold text-white">{프로젝트명}</span>}
// header.centerLogo의 'Logo'도 동일하게 {프로젝트명}으로 변경
```

---

### 2번 선택 — 레이아웃 없음

`src/app/routes/index.tsx`에서 AppLayout wrapper를 **제거**하고, PoC 페이지를 `/`에 직접 둡니다.

```tsx
// src/app/routes/index.tsx 수정 — PoC 페이지를 '/'에 직접 (AppLayout wrapper 제거)
import { createBrowserRouter } from 'react-router-dom'
import { {Feature}Page } from '@/pages/{Feature}Page'

export const routes = createBrowserRouter([
  {
    path: '/',
    element: <{Feature}Page />,
  },
])
```

> `AppLayout.tsx` 파일 자체는 삭제하지 않습니다(나중에 다시 추가 가능). 단, 라우트의 wrapper로는 사용하지 않습니다.

- [ ] 사용자가 레이아웃 적용 여부를 선택했는가?
- [ ] 선택에 따라 `src/app/routes/index.tsx`가 수정되었는가?

---

## Step 6 — 라우트 설정

`src/app/routes/`에 라우트를 추가합니다.
`setup-router` command를 참조합니다.

---

## Step 7 — build 확인

```bash
pnpm build
```

---
🟢 채비: 빌드 결과를 확인합니다.

---

- [ ] 빌드가 성공했는가? (`dist/` 폴더 생성)
  - 실패 시 → 에러 메시지 분석 후 수정, 재시도

---

## Step 8 — dev server 실행 확인

```bash
pnpm dev
```

---
🟢 채비: 브라우저에서 아래 주소로 접속해 주세요.

        `http://localhost:5173`

        화면이 정상적으로 보이면 초기화가 완료된 것입니다.

---

- [ ] dev server가 정상 실행되었는가?
- [ ] 브라우저에서 페이지가 렌더링되었는가?

---

## 완료 메시지

---
🟢 채비: 프로젝트 초기화가 완료되었습니다.

        구조:
        - src/features/{featureName}/  ← 구현 시작 위치
        - src/pages/                   ← 페이지 컴포넌트
        - src/app/routes/              ← 라우트 설정

        dev server: `http://localhost:5173`

        이제 구현 계획을 잡겠습니다.

---

plan-poc의 [6] 구현 계획 수립으로 돌아갑니다.
