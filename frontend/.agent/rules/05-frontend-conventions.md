# Rule 05 — 프론트엔드 컨벤션

> 이 파일은 기존 SaaS 레포의 `frontend-conventions.mdc`를 기반으로 작성되었습니다.
> 폴더 구조 및 네이밍 규칙은 `02-fsd.md`, `03-naming.md`가 우선합니다.
> 이 파일은 상태 관리, 데이터 페칭, 폼 처리 패턴에 집중합니다.

---

## 폼 처리 (React Hook Form + Zod)

폼이 있는 UI는 **React Hook Form**을 사용합니다. `useState`로 필드별 상태를 관리하지 않습니다.
유효성 검사가 필요하면 **Zod 스키마 + `zodResolver`**를 사용합니다.

```tsx
// ✅ GOOD
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})
type FormData = z.infer<typeof schema>

const {
  register,
  handleSubmit,
  formState: { errors },
} = useForm<FormData>({
  resolver: zodResolver(schema),
})

// ❌ BAD
const [name, setName] = useState('')
const [email, setEmail] = useState('')
```

제어 컴포넌트가 필요하면 `Controller` 또는 `useController`를 사용합니다.

---

## 서버 상태 / 데이터 페칭 (TanStack Query)

서버 데이터 조회·캐싱·동기화는 **TanStack React Query**를 사용합니다.
`useEffect` + `useState`로 직접 fetch하지 않습니다.

```tsx
// ✅ GOOD - 조회 (apis/queries/)
const { data, isLoading, error } = useQuery({
  queryKey: ['user', userId],
  queryFn: () => fetchUser(userId),
})

// ✅ GOOD - 변경 후 캐시 무효화 (apis/mutations/)
const mutation = useMutation({
  mutationFn: updateUser,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] }),
})

// ❌ BAD
useEffect(() => {
  fetch('/api/user').then(r => r.json()).then(setUser)
}, [])
```

- GET 요청 → `useQuery` → `apis/queries/` 폴더
- POST/PUT/DELETE → `useMutation` → `apis/mutations/` 폴더
- 성공 시 반드시 관련 쿼리 `invalidateQueries`로 캐시 무효화

---

## 클라이언트 상태 관리 (Context API)

여러 컴포넌트에서 공유하는 클라이언트 상태는 **Context API**를 사용합니다.
Zustand는 Context API로 해결 안 되는 복잡한 전역 UI 상태일 때만 허용합니다. Jotai는 사용하지 않습니다.

**상태 관리 도구 선택 기준:**

| 상태 종류 | 도구 |
|-----------|------|
| 서버 데이터 (API 응답) | TanStack Query |
| 폼 입력 상태 | React Hook Form |
| 전역 UI 상태 (테마, 인증, 사이드바) | Context API |

```tsx
// ✅ GOOD - Context + 커스텀 훅 패턴
// src/contexts/AuthContext.tsx
const AuthContext = createContext<AuthContextValue | null>(null)

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>
}

// 커스텀 훅으로 제공
export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
```

Provider는 `src/contexts/`에 두고, `src/main.tsx`에서 조합합니다.

---

## 공유 UI 컴포넌트

> 현재 디자인 소스는 `rules/07-design.md`에 선언되어 있습니다.
> 디자인 소스 교체가 필요하면 `07-design.md`의 `PRIMARY_UI_PACKAGE`만 변경합니다.

공유 UI는 **`@genai/ui` 패키지**를 사용합니다.
Button, Modal, Input 등은 해당 패키지에서 import합니다.

```tsx
// ✅ GOOD
import { Button, Modal } from '@genai/ui'

// ❌ BAD - shared/components에 Button을 새로 만들지 않는다
import { Button } from '@/components/Button'
```

`@genai/ui`에 없는 컴포넌트는 feature 내부(`src/features/{name}/components/`)에 먼저 만듭니다.
여러 feature에서 공통으로 쓰일 때만 `src/components/`로 올립니다.

---

## 환경변수

환경변수는 `src/constants/env.ts` 또는 `src/lib/config.ts`에서 **중앙 관리**합니다.
컴포넌트나 훅에서 `import.meta.env`를 직접 참조하지 않습니다.

```ts
// ✅ GOOD - src/constants/env.ts
export const ENV = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  APP_ENV: import.meta.env.VITE_APP_ENV ?? 'development',
} as const

// ✅ 사용 시
import { ENV } from '@/constants/env'

// ❌ BAD - 컴포넌트에서 직접 참조
const url = import.meta.env.VITE_API_BASE_URL  // ❌ 컴포넌트에서 직접 참조 금지
```

---

## URL 경로

URL 경로는 **kebab-case**를 사용합니다. 예외 없습니다.

```
✅ /user-profile
✅ /document-manager
✅ /gen-ai/sql-agent

❌ /userProfile
❌ /document_manager
❌ /genAi/sqlAgent
```

---

## 기타 원칙

```
✅ 함수형 컴포넌트만 사용한다. 클래스 컴포넌트를 새로 작성하지 않는다.
✅ 재사용 가능한 로직은 커스텀 훅으로 분리한다.
✅ API 호출은 feature의 apis/ 폴더에 모은다. 컴포넌트에서 직접 fetch URL을 쓰지 않는다.
❌ useEffect + useState로 서버 데이터를 fetch하지 않는다.
❌ 폼 필드를 useState로 관리하지 않는다.
```

---

## 스타일 작성

### 우선순위

```
1순위: Tailwind 유틸리티 클래스
2순위: 인라인 CSS — Tailwind로 표현 불가한 속성에 한해 허용
3순위: CSS Module (.module.css) — 인라인 CSS가 많아져 분리가 필요한 경우
```

```tsx
// ✅ 1순위: Tailwind
<div className="flex items-center gap-2 px-4 py-2 rounded-lg" />

// ✅ 2순위: 인라인 CSS (Tailwind에 없는 속성)
<div style={{ scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }} />

// ✅ 3순위: CSS Module (인라인이 복잡해질 때 분리)
import styles from './Component.module.css'
<div className={styles.container} />

// ❌ 전역 CSS에 컴포넌트 전용 스타일 작성
// ❌ Tailwind로 가능한데 인라인 CSS 사용
```
