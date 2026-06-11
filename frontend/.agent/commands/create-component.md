# Command: create-component

> FSD 레이어에 맞는 컴포넌트 파일 구조를 생성하는 절차서입니다.
> segment 이름은 FSD 표준이 아닌 **SaaS 레포 컨벤션**을 따릅니다.
> (`ui/` → `components/`, `model/` → `hooks/`, `api/` → `apis/queries/` + `apis/mutations/`)

---

## 구현 전 설계 정의 (REQUIRED)

> 파일을 생성하기 전에 아래 5가지를 반드시 정의합니다.
> 정의되지 않은 항목이 있으면 사용자에게 확인 후 진행합니다.
> 이 단계를 건너뛰면 인터페이스가 구현 도중 바뀌어 테스트와 코드가 불일치합니다.

### [1] 기능 요구사항

```
- 시스템이 반드시 해야 하는 일:
- happy path:
- 예외 상황:
```

### [2] 입력

```
- 입력 타입 (Props interface / 함수 파라미터):
- 필수 필드:
- 선택 필드:
- 유효성 조건:
- 중복/빈 값 처리:
```

### [3] 출력

```
- 반환 타입:
- 정렬 기준: (목록인 경우)
- group by 기준: (그룹핑이 있는 경우)
- error 형식:
- empty 처리:
```

### [4] 제약

```
- 정확성: (데이터 일치 조건)
- 성능: (PoC 기준 허용 범위)
- 일관성: (다른 컴포넌트와의 패턴 통일)
- 권한: (접근 제한이 있는가)
- 확장성: (이후 변경 가능성)
```

### [5] 변경 가능성

```
- 자주 바뀔 수 있는 정책:
- 분리해야 할 책임:
- 필요한 패턴 후보:
```

> **작성 방법:**
> 모든 항목을 채울 필요는 없습니다. 해당 없으면 `N/A`로 표시하고 넘어갑니다.
> 단, [1] 기능 요구사항과 [2] 입력은 반드시 작성합니다.

---

## 사전 조건 확인

- [ ] `rules/02-fsd.md`를 읽었는가?
- [ ] `rules/03-naming.md`를 읽었는가?
- [ ] 생성할 컴포넌트가 어느 레이어에 속하는지 결정했는가?

### 레이어 결정 기준

| 질문 | 레이어 |
|------|--------|
| URL에 직접 대응하는 페이지인가? | `src/pages/` |
| 특정 기능에 속하는 컴포넌트/훅/API인가? | `src/features/{name}/` |
| 특정 feature에서만 쓰는 컴포넌트인가? | `src/features/{name}/components/` |
| 여러 feature에서 재사용되는 공통 UI인가? | `src/components/` |
| 앱 전역 상태 (인증, 토스트)인가? | `src/contexts/` |
| 여러 feature에서 공유하는 훅인가? | `src/hooks/` |

결정이 어려우면 `shared`에 두고 나중에 올립니다.

---

## pages 레이어

```
src/pages/
├── {PageName}Page.tsx
└── {PageName}Page.test.tsx
```

pages는 feature 컴포넌트를 import해서 반환하는 **얇은 레이어**입니다.
비즈니스 로직, 상태 관리, API 호출을 pages에 직접 작성하지 마세요.

**`{PageName}Page.tsx`**
```tsx
import {FeatureName} from '@/features/{feature-name}/{FeatureName}'

const {PageName}Page = () => {
  return <{FeatureName} />
}

export default {PageName}Page
```

**`{PageName}Page.test.tsx`**
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {PageName}Page from './{PageName}Page'

describe('{PageName}Page', () => {
  it('페이지가 정상적으로 렌더링된다', () => {
    render(<MemoryRouter><{PageName}Page /></MemoryRouter>)
    expect(screen.getByRole('main')).toBeInTheDocument()
  })
})
```

### 체크리스트
- [ ] 파일이 `src/pages/` 직하에 위치하는가?
- [ ] 비즈니스 로직 없이 feature만 조합하는가?
- [ ] 테스트 파일이 생성되었는가?
- [ ] 라우트 등록이 필요하면 `setup-router` command를 실행했는가?

---

## 컴포넌트 위치 결정 원칙

> **기본값은 feature 내부입니다.**
>
> ```
> 특정 feature에서 사용 → src/features/{name}/components/
> 여러 feature에서 공통으로 사용 → src/components/
> ```
>
> `src/components/`는 최소화합니다. 확실히 공통이 아니라면 feature 내부에 먼저 만들고, 재사용이 필요해질 때 올립니다.

## features 레이어

새 feature는 `src/features/_template/`을 복사해서 시작합니다.

```bash
cp -r src/features/_template src/features/{featureName}
```

```
src/features/{featureName}/
├── apis/
│   ├── mutations/            ← useMutation 훅 (POST/PUT/DELETE)
│   │   └── use{Name}Mutation.ts
│   └── queries/              ← useQuery 훅 (GET)
│       └── use{Name}Query.ts
├── components/               ← 기능 전용 컴포넌트
│   └── {ComponentName}.tsx
├── contexts/                 ← 기능 전용 Context (선택)
├── hooks/                    ← 비즈니스 로직 훅
│   └── use{FeatureName}.ts
├── types.ts                  ← 타입 정의
├── utils/                    ← 유틸 함수 (선택)
└── {FeatureName}.tsx         ← 기능 메인 컴포넌트
```

**`{FeatureName}.tsx`** — 메인 컴포넌트
```tsx
import { use{FeatureName} } from './hooks/use{FeatureName}'

interface {FeatureName}Props {
  className?: string
}

const {FeatureName} = ({ className }: {FeatureName}Props) => {
  const { /* 필요한 값 */ } = use{FeatureName}()
  return <div className={className}>{/* UI */}</div>
}

export default {FeatureName}
```

**`hooks/use{FeatureName}.ts`** — 비즈니스 로직
```ts
export const use{FeatureName} = () => {
  // 비즈니스 로직
  return { /* 반환값 */ }
}
```

**`apis/queries/use{Name}Query.ts`** — GET
```ts
import { useQuery } from '@tanstack/react-query'
import { api } from '@/app/apis'

export const use{Name}Query = () =>
  useQuery({
    queryKey: ['{name}'],
    queryFn: async () => {
      const response = await api.get('/api/{endpoint}')
      return response
    },
  })
```

**`apis/mutations/use{Name}Mutation.ts`** — POST/PUT/DELETE
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/app/apis'

export const use{Name}Mutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: unknown) => {
      const response = await api.post('/api/{endpoint}', data)
      return response
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['{name}'] })
    },
  })
}
```

**`types.ts`**
```ts
export interface {FeatureName}Item {
  id: string
  // 필드 정의
}
```

**테스트: `components/{ComponentName}.test.tsx`**
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {FeatureName} from '../{FeatureName}'

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('{FeatureName}', () => {
  it('정상적으로 렌더링된다', () => {
    render(<{FeatureName} />, { wrapper: createWrapper() })
  })
})
```

### 체크리스트
- [ ] `_template`을 복사해서 시작했는가?
- [ ] API 호출은 `apis/queries/` 또는 `apis/mutations/`에 있는가?
- [ ] 비즈니스 로직은 `hooks/`에 분리되었는가?
- [ ] `any` 타입이 없는가?
- [ ] 테스트 파일이 생성되었는가?

---

## src/components/ 레이어 (공통 컴포넌트)

> `@genai/ui`에 없는 컴포넌트만 여기에 만듭니다.
> 먼저 `@genai/ui`에 동일한 컴포넌트가 있는지 확인합니다.

```
src/components/
└── {ComponentName}.tsx
```

**`{ComponentName}.tsx`**
```tsx
interface {ComponentName}Props {
  className?: string
  children?: React.ReactNode
}

const {ComponentName} = ({ className, children }: {ComponentName}Props) => {
  return <div className={className}>{children}</div>
}

export default {ComponentName}
```

### 체크리스트
- [ ] `@genai/ui`에 동일 컴포넌트가 없는지 확인했는가?
- [ ] 도메인 로직이 없는 순수 UI인가?
- [ ] 테스트 파일이 생성되었는가?

---

## 공통 최종 체크리스트

- [ ] 컴포넌트 파일명이 PascalCase인가?
- [ ] `any` 타입이 없는가?
- [ ] `console.log`가 없는가?
- [ ] 테스트 파일이 생성되었는가?
