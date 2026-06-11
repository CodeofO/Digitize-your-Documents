# Command: setup-router

> 새로운 라우트를 추가할 때 AI 에이전트가 따라야 할 절차서입니다.
> React Router DOM v7 `createBrowserRouter` + 도메인별 RouteObject 분리 패턴을 기준으로 합니다.

---

## 라우터 파일 구조

```
src/app/routes/
├── index.tsx              ← createBrowserRouter 정의
├── routes.ts              ← ROUTES 경로 상수
└── {domain}Routes.tsx     ← 도메인별 RouteObject
```

### AppLayout 적용 여부에 따른 패턴

**AppLayout 적용 (init-poc Step 5에서 "예" 선택)**

새 페이지는 AppLayout의 `children`에 추가합니다.
`src/layouts/AppLayout.tsx`의 `navItems`에 메뉴도 함께 등록합니다.

```tsx
// src/app/routes/index.tsx
export const routes = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'new-page', element: <NewPage /> }, // 추가
    ],
  },
])
```

**AppLayout 미적용 (init-poc Step 5에서 "아니오" 선택)**

각 페이지를 최상위 라우트로 독립 등록합니다.

```tsx
// src/app/routes/index.tsx
export const routes = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/new-page', element: <NewPage /> }, // 추가
])
```

> ⚠️ 이 구조는 기존 SaaS 레포와 **의도적으로 다릅니다.**
> SaaS 레포는 경로를 하드코딩하지만, 이 boilerplate는 AI가 경로를 추측하지 않도록 ROUTES 상수를 강제합니다.

---

## 사전 조건 확인

- [ ] `react-router-dom`이 `package.json`에 존재하는가?
  - 없으면 설치: `pnpm add react-router-dom@^7.6.0` (이 프로젝트는 pnpm 전용)
- [ ] `src/app/routes/` 디렉토리가 존재하는가?
  - 없으면 Step 1부터 실행
  - 있으면 Step 3으로 바로 이동

---

## Step 1 — 라우터 초기화 (최초 1회)

### 1-1. `routes.ts` 생성 — 경로 상수 파일

경로 문자열은 **이 파일에서만** 관리합니다. 어디서도 경로 문자열을 하드코딩하지 마세요.

```ts
// src/app/routes/routes.ts
export const ROUTES = {
  ROOT: '/',
  NOT_FOUND: '*',
} as const

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES]
```

### 1-2. `index.tsx` 생성 — 루트 라우터 정의

```tsx
// src/app/routes/index.tsx
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { ROUTES } from './routes'

export const router = createBrowserRouter([
  {
    path: ROUTES.ROOT,
    element: <Navigate to="/home" replace />,
  },
  {
    path: ROUTES.NOT_FOUND,
    element: <div>404 Not Found</div>,
  },
])
```

### 1-3. RouterProvider 연결

```tsx
// src/main.tsx
import { RouterProvider } from 'react-router-dom'
import { router } from '@/app/routes'

const App = () => <RouterProvider router={router} />
```

- [ ] RouterProvider가 앱 최상단에 연결되었는가?

---

## Step 2 — 페이지 컴포넌트 생성

### 2-1. FSD pages 슬라이스 구조로 생성

```
src/pages/{page-name}/
├── ui/
│   └── {PageName}Page.tsx   ← 페이지 컴포넌트
└── index.ts                 ← Public API (re-export만)
```

### 2-2. 페이지 컴포넌트 작성

```tsx
// src/pages/{page-name}/ui/{PageName}Page.tsx
const {PageName}Page = () => {
  return (
    <main>
      <h1>{PageName}</h1>
    </main>
  )
}

export default {PageName}Page
```

### 2-3. `index.ts` 작성

```ts
// src/pages/{page-name}/index.ts
export { default as {PageName}Page } from './ui/{PageName}Page'
```

- [ ] `index.ts`가 존재하고 default export를 re-export하는가?

---

## Step 3 — 도메인 RouteObject 파일 생성 또는 수정

라우트는 도메인 단위로 분리합니다. 기존 파일이 있으면 수정, 없으면 신규 생성합니다.

### 3-1. `routes.ts`에 경로 상수 추가

```ts
export const ROUTES = {
  ROOT: '/',
  {DOMAIN}_ROOT: '/{domain}',          // 도메인 루트
  {DOMAIN}_{PAGE}: '/{domain}/{page}', // 하위 경로
  NOT_FOUND: '*',
} as const
```

### 3-2. 도메인 RouteObject 파일 생성

**패턴: 도메인 최상단에 Suspense, 하위 페이지는 lazy**

```tsx
// src/app/routes/{domain}Routes.tsx
import { lazy, Suspense } from 'react'
import { Navigate, Outlet, RouteObject } from 'react-router-dom'
import LoadingFallback from '@/shared/ui/LoadingFallback'
import { ROUTES } from './routes'

// 레이아웃, Provider 등 핵심 컴포넌트 → eager import
// import { DomainProvider } from '@/features/{domain}/providers/DomainProvider'

// 페이지 컴포넌트 → lazy import
const {PageName}Page = lazy(() => import('@/pages/{page-name}/ui/{PageName}Page'))

export const {domain}Routes: RouteObject = {
  path: ROUTES.{DOMAIN}_ROOT,
  element: (
    <Suspense fallback={<LoadingFallback />}>
      <Outlet />
    </Suspense>
  ),
  children: [
    {
      index: true,
      element: <Navigate to={ROUTES.{DOMAIN}_{PAGE}} replace />,
    },
    {
      path: ROUTES.{DOMAIN}_{PAGE},
      element: <{PageName}Page />,
    },
  ],
}
```

> **lazy/eager 기준:**
> - 레이아웃, Provider, AuthGuard → eager (앱 초기화에 필요)
> - 페이지 컴포넌트 → lazy (항상)

### 3-3. `index.tsx`에 도메인 RouteObject 등록

```tsx
// src/app/routes/index.tsx
import { {domain}Routes } from './{domain}Routes'

export const router = createBrowserRouter([
  // 기존 라우트...
  {domain}Routes,         // 추가
  {
    path: ROUTES.NOT_FOUND,
    element: <div>404</div>,
  },
])
```

- [ ] `routes.ts`에 경로 상수가 추가되었는가?
- [ ] 도메인 RouteObject 파일이 생성 또는 수정되었는가?
- [ ] `index.tsx`에 RouteObject가 등록되었는가?

---

## Step 4 — 네비게이션 연결

### 링크 컴포넌트

```tsx
import { Link } from 'react-router-dom'
import { ROUTES } from '@/app/router/routes'

<Link to={ROUTES.{DOMAIN}_{PAGE}}>페이지 이름</Link>
```

### 프로그래매틱 네비게이션

```tsx
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '@/app/router/routes'

const navigate = useNavigate()
navigate(ROUTES.{DOMAIN}_{PAGE})
```

> 경로 문자열 직접 작성 금지. 반드시 `ROUTES` 상수를 참조하세요.

---

## Step 5 — 최종 검증

- [ ] 새 경로로 직접 접근했을 때 페이지가 렌더링되는가?
- [ ] 존재하지 않는 경로 접근 시 404가 표시되는가?
- [ ] 콘솔 에러가 없는가?
- [ ] `ROUTES` 상수 외에 경로 문자열 하드코딩이 없는가?
- [ ] 페이지 컴포넌트가 `index.ts`를 통해 export되는가?
- [ ] 페이지 컴포넌트가 lazy로 import되었는가?
- [ ] Suspense fallback이 도메인 RouteObject 최상단에 있는가?

---

## 자주 하는 실수

| 실수 | 올바른 방법 |
|------|------------|
| `<a href="/path">` 사용 | `<Link to={ROUTES.PATH}>` 사용 |
| 경로 문자열 하드코딩 | `ROUTES` 상수 참조 |
| 중첩 라우트 자식 경로에 `/` prefix | 상대 경로 사용 (`page`, not `/domain/page`) |
| 페이지를 eager import | 페이지 컴포넌트는 항상 `lazy()` 사용 |
| Suspense를 각 페이지마다 개별 적용 | 도메인 RouteObject 최상단 `element`에 한 번만 |
| `RouterProvider` 없이 `useNavigate` 호출 | RouterProvider 컨텍스트 안에서만 사용 |
| SaaS 레포 패턴(하드코딩) 그대로 복사 | 이 boilerplate는 ROUTES 상수 필수 |
