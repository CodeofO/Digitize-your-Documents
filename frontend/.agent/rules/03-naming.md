# Rule 03 — 네이밍 컨벤션

## 파일 및 폴더

| 대상 | 규칙 | 예시 |
|------|------|------|
| 컴포넌트 파일 | PascalCase | `UserCard.tsx`, `LoginForm.tsx` |
| 훅 파일 | camelCase, `use` prefix | `useUserList.ts`, `useAuth.ts` |
| 유틸 함수 파일 | camelCase | `formatDate.ts`, `parseQuery.ts` |
| 타입 정의 파일 | camelCase | `user.types.ts`, `api.types.ts` |
| 상수 파일 | camelCase | `routes.ts`, `config.ts` |
| 슬라이스 폴더 | kebab-case | `user-profile/`, `data-filter/` |
| Segment 폴더 | 고정 이름 | `components/`, `hooks/`, `apis/queries/`, `apis/mutations/`, `utils/` |
| index 파일 | 항상 소문자 | `index.ts`, `index.tsx` |

---

## TypeScript

### 컴포넌트 Props

```ts
// ✅ interface 사용, 컴포넌트명 + Props
interface UserCardProps {
  userId: string
  name: string
  avatarUrl?: string
  onSelect?: (userId: string) => void
}

// ❌ type alias 사용 금지 (Props에 한해)
type UserCardProps = { ... }
```

### 타입 및 인터페이스

```ts
// ✅ PascalCase
interface UserProfile { ... }
type ApiResponse<T> = { data: T; status: number }

// ❌ 헝가리안 표기법 금지
interface IUserProfile { ... }  // I prefix 금지
type TApiResponse = { ... }     // T prefix 금지
```

### Enum

> **Enum을 권장합니다.** `const assertion` 방식보다 TypeScript enum을 사용합니다.
> IDE 자동완성, 타입 안전성, 가독성이 모두 우수합니다.

```ts
// ✅ 권장 — TypeScript enum
enum UserRole {
  ADMIN = 'ADMIN',
  VIEWER = 'VIEWER',
}

// ❌ 비권장 — const assertion
const USER_ROLE = {
  ADMIN: 'ADMIN',
  VIEWER: 'VIEWER',
} as const
type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE]
```

### 제네릭 타입 파라미터

```ts
// ✅ 의미 있는 이름 사용
function fetchEntity<TEntity>(id: string): Promise<TEntity>

// ❌ 단일 알파벳은 TData처럼 T prefix 붙이거나 의미 있는 이름 사용
function fetchEntity<T>(id: string): Promise<T>  // 허용하나 권장하지 않음
```

---

## React 컴포넌트

### 컴포넌트 선언

```tsx
// ✅ function declaration (arrow function 모두 허용, 단 팀 내 통일)
// 이 프로젝트: arrow function + const 사용
const UserCard = ({ userId, name }: UserCardProps) => {
  return <div>{name}</div>
}

export default UserCard
```

### 이벤트 핸들러

```tsx
// ✅ handle + 이벤트 대상 + 동작
const handleSubmitClick = () => { ... }
const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => { ... }

// ❌ 짧고 불명확한 이름
const click = () => { ... }
const onChange = () => { ... }  // 너무 일반적
```

### 커스텀 훅

```ts
// ✅ use prefix + 명확한 목적
const useUserList = () => { ... }
const useFilteredData = (rawData: DataItem[]) => { ... }

// ✅ 반환값이 단일 값이면 값 직접 반환
const useWindowWidth = (): number => { ... }

// ✅ 반환값이 복수이면 객체 반환 (배열 반환 지양)
const useAuth = () => ({
  user,
  isLoading,
  login,
  logout,
})
```

---

## API 및 상태

### API 함수

```ts
// ✅ HTTP 메서드 동사 + 리소스명
const getUser = (userId: string): Promise<User> => { ... }
const createReport = (data: CreateReportDto): Promise<Report> => { ... }
const updateUserProfile = (id: string, data: UpdateProfileDto) => { ... }
const deleteItem = (itemId: string) => { ... }
```

### TanStack Query 훅

```ts
// ✅ use + 리소스명 + Query (apis/queries/ 위치)
const useUserQuery = (userId: string) => useQuery(...)
const useUserListQuery = (params: ListParams) => useQuery(...)

// ✅ use + 리소스명 + Mutation (apis/mutations/ 위치)
const useCreateReportMutation = () => useMutation(...)
const useDeleteItemMutation = () => useMutation(...)
```

> Query와 Mutation은 반드시 분리된 폴더에 위치합니다.
> `features/{name}/apis/queries/` ← useQuery
> `features/{name}/apis/mutations/` ← useMutation

### Query Key

```ts
// ✅ 배열 형태, 계층 구조 유지
const userKeys = {
  all: ['users'] as const,
  lists: () => [...userKeys.all, 'list'] as const,
  list: (params: ListParams) => [...userKeys.lists(), params] as const,
  details: () => [...userKeys.all, 'detail'] as const,
  detail: (id: string) => [...userKeys.details(), id] as const,
}
```

---

## 상수 및 환경변수

```ts
// ✅ 상수: UPPER_SNAKE_CASE
const MAX_RETRY_COUNT = 3
const DEFAULT_PAGE_SIZE = 20

// ✅ 환경변수 래퍼: src/constants/env.ts에서 중앙 관리
// .env 직접 참조 금지 — 반드시 config를 통해
export const ENV = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  APP_ENV: import.meta.env.VITE_APP_ENV ?? 'development',
} as const
```

---

## CSS / 스타일

이 프로젝트는 **인라인 Tailwind 유틸리티** 또는 **CSS Modules**을 사용합니다.

```tsx
// Tailwind 사용 시
// 클래스 순서: layout → sizing → spacing → typography → color → effect
<div className="flex items-center gap-3 px-4 py-2 text-sm text-gray-700 bg-white rounded-lg shadow">

// CSS Modules 사용 시
import styles from './UserCard.module.css'
// 클래스명: camelCase
<div className={styles.cardWrapper}>
```
