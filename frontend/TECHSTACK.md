# TECH STACK

> 이 문서는 agent가 참조하는 기술 스택 가이드입니다.
> 새 패키지 설치 시 반드시 아래 명시된 버전을 사용하세요. 임의 최신 버전 설치 금지.

---

## 1. 폴더 구조

```
src/
├── app/                   # 애플리케이션 설정
│   ├── apis/              # API 클라이언트 설정 (axios 인스턴스 등)
│   └── routes/            # 라우트 정의
├── assets/                # 정적 자산
│   ├── fonts/
│   ├── icons/
│   └── images/
├── components/            # 공통 재사용 컴포넌트
├── constants/             # 상수 정의
├── contexts/              # React Context (전역 상태 — 인증, 토스트 등)
├── features/              # 기능별 독립 모듈
│   └── [featureName]/
│       ├── apis/
│       │   ├── mutations/ # POST, PUT, DELETE
│       │   └── queries/   # GET
│       ├── components/
│       ├── contexts/
│       ├── hooks/
│       ├── types.ts
│       └── utils/
├── hooks/                 # 전역 커스텀 훅
├── i18n/                  # 다국어 설정
├── layouts/               # 레이아웃 컴포넌트
├── lib/                   # 라이브러리 설정
├── pages/                 # 페이지 컴포넌트 (라우트 단위)
├── utils/                 # 전역 유틸리티
└── main.tsx               # 엔트리 포인트
```

---

## 2. 아키텍처 패턴

### 계층 구조

```
Pages (라우트)
  └─ 페이지 컴포넌트만 포함, 비즈니스 로직 최소화
       ↓
Features (기능 모듈)
  └─ 독립적인 기능 단위, 자체 API / 컴포넌트 / 훅 포함
       ↓
Components (공통 컴포넌트)
  └─ 재사용 가능한 UI 컴포넌트
       ↓
App (설정)
  └─ API 클라이언트, 라우팅 설정
```

### 데이터 흐름

```
User Action
    ↓
Page Component
    ↓
Feature Component / Hook
    ↓
API Call (React Query)
    ↓
API Client (Axios)
    ↓
Backend
```

### 상태 관리 전략

| 상태 유형 | 도구 |
|----------|------|
| 서버 상태 | TanStack Query |
| 로컬 UI 상태 | useState, useReducer |
| 전역 상태 | React Context API (인증, 토스트 등) |
| 폼 상태 | React Hook Form |

---

## 3. 네이밍 컨벤션

### 파일명

| 유형 | 규칙 | 예시 |
|------|------|------|
| 컴포넌트 | PascalCase | `UserManagementPage.tsx` |
| 유틸리티 / 훅 | camelCase | `tokenUtils.ts`, `useLogin.ts` |
| 상수 | camelCase | `queryKeys.ts` |
| 타입 | camelCase 또는 types.ts | `types.ts` |

### 컴포넌트명

| 유형 | 패턴 | 예시 |
|------|------|------|
| 페이지 컴포넌트 | `[PageName]Page` | `LoginPage` |
| 기능 컴포넌트 | `[FeatureName]` | `FileManager` |
| 공통 컴포넌트 | 명확한 기능명 | `Button`, `Modal` |

---

## 4. 기술 스택

### 핵심 (기본 설치 완료)

| 패키지 | 버전 | 용도 |
|--------|------|------|
| react | 18.2.0 | UI 프레임워크 |
| react-dom | 18.2.0 | DOM 렌더링 |
| typescript | 5.7.3 | 타입 안전성 |
| vite | 5.1.0 | 빌드 도구 |
| react-router-dom | 7.6.0 | 클라이언트 라우팅 |
| axios | latest | HTTP 클라이언트 |

### 스타일링

| 패키지 | 버전 | 용도 |
|--------|------|------|
| tailwindcss | 3.4.1 | 유틸리티 CSS |
| @radix-ui/* | latest | UI 프리미티브 |
| lucide-react | latest | 아이콘 |

### 서버 상태 관리

| 패키지 | 버전 | 용도 |
|--------|------|------|
| @tanstack/react-query | 5.80.7 | 서버 상태 관리 |
| @tanstack/react-query-devtools | 5.x | 개발 도구 |

### 폼 관리

| 패키지 | 버전 | 용도 |
|--------|------|------|
| react-hook-form | 7.62.0 | 폼 상태 관리 |
| zod | 4.1.8 | 스키마 유효성 검사 |
| @hookform/resolvers | latest | RHF + Zod 연결 |

### 국제화

| 패키지 | 버전 | 용도 |
|--------|------|------|
| i18next | 21.6.14 | 다국어 처리 |
| react-i18next | 11.16.2 | React 바인딩 |

### 기타

| 패키지 | 버전 | 용도 |
|--------|------|------|
| dayjs | latest | 날짜 처리 |
| uuid | latest | 고유 ID 생성 |

---

## 5. 선택 설치 패키지

아래 패키지는 필요한 경우에만 설치합니다.
agent는 사용자 요청을 분석해 필요 여부를 판단 후 설치를 제안하세요.

---

### TanStack Query

**설치**
```bash
pnpm add @tanstack/react-query
pnpm add -D @tanstack/react-query-devtools
```

**언제 사용하나요?**
- API 호출 결과를 캐싱해야 할 때
- 로딩 / 에러 상태를 선언적으로 관리할 때
- 서버 데이터를 주기적으로 refetch해야 할 때

**설정 — `src/app/providers/QueryProvider.tsx`**
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5분
      retry: 1,
    },
  },
})

export function QueryProvider({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

**사용 예시 — `src/features/user/apis/queries/useGetUser.ts`**
```tsx
import { useQuery } from '@tanstack/react-query'

export function useGetUser(userId: string) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(res => res.json()),
  })
}
```

---

### React Hook Form + Zod

**설치**
```bash
pnpm add react-hook-form zod @hookform/resolvers
```

**언제 사용하나요?**
- 입력 폼이 있을 때
- 유효성 검사 로직이 필요할 때

**사용 예시 — `src/features/auth/components/LoginForm.tsx`**
```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email('올바른 이메일 형식이 아닙니다'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다'),
})

type FormValues = z.infer<typeof schema>

export function LoginForm() {
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  })

  return (
    <form onSubmit={handleSubmit(console.log)}>
      <input {...register('email')} placeholder="이메일" />
      {errors.email && <p>{errors.email.message}</p>}
      <input {...register('password')} type="password" placeholder="비밀번호" />
      {errors.password && <p>{errors.password.message}</p>}
      <button type="submit">로그인</button>
    </form>
  )
}
```

---

### Chart.js

**설치**
```bash
pnpm add chart.js react-chartjs-2
```

**언제 사용하나요?**
- 라인 / 바 / 파이 등 데이터 시각화가 필요할 때

**사용 예시 — `src/features/dashboard/components/RevenueChart.tsx`**
```tsx
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend)

const data = {
  labels: ['1월', '2월', '3월', '4월', '5월'],
  datasets: [{ label: '매출', data: [100, 200, 150, 300, 250], borderColor: 'rgb(75, 192, 192)', tension: 0.1 }],
}

export function RevenueChart() {
  return <Line data={data} />
}
```

---

### Zustand

**설치**
```bash
pnpm add zustand
```

**언제 사용하나요?**
- React Context로 해결 안 되는 복잡한 전역 클라이언트 상태일 때
- 서버 상태(TanStack Query)가 아닌 순수 UI 전역 상태일 때

**사용 예시 — `src/lib/store/useUIStore.ts`**
```tsx
import { create } from 'zustand'

interface UIStore {
  isSidebarOpen: boolean
  toggleSidebar: () => void
}

export const useUIStore = create<UIStore>(set => ({
  isSidebarOpen: false,
  toggleSidebar: () => set(state => ({ isSidebarOpen: !state.isSidebarOpen })),
}))
```

---

### dayjs

**설치**
```bash
pnpm add dayjs
```

**언제 사용하나요?**
- 날짜 포맷 / 연산 / 비교가 필요할 때

**사용 예시**
```tsx
import dayjs from 'dayjs'
import 'dayjs/locale/ko'

dayjs.locale('ko')

dayjs('2024-01-01').format('YYYY년 MM월 DD일') // 2024년 01월 01일
dayjs().subtract(7, 'day').fromNow()           // 7일 전
dayjs('2024-12-31').diff(dayjs(), 'day')       // D-day 계산
```

---

## 6. 국제화 (i18n)

### 설정 — `src/i18n/i18n.ts`

```typescript
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import koTranslation from './locales/ko'
import enTranslation from './locales/en'
import jaTranslation from './locales/ja'

i18n.use(initReactI18next).init({
  resources: {
    ko: { translation: koTranslation },
    en: { translation: enTranslation },
    ja: { translation: jaTranslation },
  },
  fallbackLng: 'ko',
  keySeparator: '.',
})
```

### 사용

```tsx
import { useTranslation } from 'react-i18next'

function Component() {
  const { t } = useTranslation()
  return <h1>{t('common.welcome')}</h1>
}
```

### 번역 키 추가 — `src/i18n/locales/ko.ts`

```typescript
const ko = {
  common: {
    welcome: '환영합니다',
    save: '저장',
  },
  userManagement: {
    title: '사용자 관리',
    add: '추가',
  },
}
```

> **주의**: 개발 모드에서는 누락된 키가 있으면 에러가 발생하도록 구현되어 있습니다.

---

## 7. 빌드 및 배포

### 빌드

```bash
pnpm build
```

### 빌드 산출물

- `dist/` 폴더에 빌드 결과물 생성
- `dist/assets/` 에 정적 자산 포함

---

## 8. 패키지 설치 규칙 (agent 필독)

1. **버전 고정** — 4섹션에 명시된 버전을 벗어난 설치 금지
2. **중복 금지** — 서버 상태는 TanStack Query, 전역 UI 상태는 Context API (복잡한 경우 Zustand) — 역할 중복 설치 금지
3. **설치 전 확인** — `pnpm list {패키지명}` 으로 기설치 여부 먼저 확인
4. **devDependencies 구분** — devtools, 타입 패키지는 반드시 `-D` 플래그로 설치