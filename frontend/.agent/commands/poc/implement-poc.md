# Command: implement

> Tech Spec 기반으로 기능을 구현하는 절차서입니다.
> **전제 조건:** `plan-poc` command가 완료되고 Spec이 `approved` 상태여야 합니다.

---

## 사전 조건 확인 (HARD BLOCK)

아래 조건이 하나라도 충족되지 않으면 **즉시 중단하고 사용자에게 알립니다.**

> **테스트 환경 확인:** 보일러플레이트에 vitest가 기본 설치되어 있지 않습니다.
> 테스트 실행 전 아래 명령어로 설치합니다. (`vitest`는 `^2.0.0` 고정 — `rules/04-dependencies.md`)
> ```bash
> pnpm add -D vitest@^2.0.0 @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
> ```
> `vite.config.ts`에 test 설정도 추가합니다:
> ```ts
> import { defineConfig } from 'vite'
> export default defineConfig({
>   test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'] }
> })
> ```
어떠한 이유로도 이 조건을 건너뛰지 마세요.

```
중단 메시지 예시:
"구현을 시작하기 전에 plan-poc command를 먼저 실행해야 합니다.
docs/tech-specs/{feature-name}.spec.md 파일이 없거나 테스트 시나리오가 작성되지 않았습니다.
plan-poc command를 실행해주세요."
```

- [ ] `docs/tech-specs/{feature-name}.spec.md`가 존재하는가?
- [ ] Spec 상태가 `approved`인가?
- [ ] Spec 섹션 6 (Testing)가 작성되어 있는가?
- [ ] plan-poc command의 구현 계획이 사용자 승인을 받았는가?

---

## 구현 사이클

각 구현 단위(파일 하나)마다 아래 사이클을 반복합니다.

```
테스트 작성 → 구현 → 테스트 통과 확인 → 다음 파일
```

사이클을 건너뛰지 마세요. 테스트 없이 구현 파일만 만들지 마세요.

### auto-sync-spec 자동 실행 조건

구현 도중 아래 상황을 감지하면 즉시 `auto-sync-spec` command를 실행합니다.

```
- Spec의 API 구조와 실제 API가 다름
- Spec의 Component Tree와 실제 구현 구조가 달라짐
- Spec에 없는 Edge Case 처리가 필요한 상황
- Goals 중 하나가 구현 불가능하거나 범위가 바뀜
```

`auto-sync-spec` 참조: `.agent/commands/poc/auto-sync-spec.md`

---

## 진행 상황 중계 (필수)

구현은 오래 걸리므로, 사용자가 답답하지 않도록 **단계 경계마다 진행 상황을 중계**합니다.

구현 시작 시 라이브 체크리스트를 한 번 보여주고, 각 Step 완료 시 갱신합니다.

```
---
🟢 채비: 구현을 시작합니다. 단계마다 진행 상황을 알려드릴게요.

        진행 상황
        ✅ 타입 정의
        ⏳ Query/Mutation 훅      ← 지금 작성 중
        ⬜ 비즈니스 로직 훅
        ⬜ UI 컴포넌트
        ⬜ 페이지 + 라우트 연결
        ⬜ 전체 검증

        (방금: {EntityName} 타입 정의 완료 → 다음: 목록 조회 훅 + 테스트)
---
```

- 단계 단위로만 중계합니다(파일 하나하나는 과합니다).
- "방금 끝난 것 → 다음 할 것"을 구체적으로 한 줄. 추상 용어 대신 실제 산출물로 표현합니다.
- `vitest`처럼 오래 걸리는 명령 직전에는 "조금 걸려요" 한 줄을 먼저 안내합니다.
- **구현 구간이 끝나면** `plan-poc`에서 생성한 `docs/poc-e2e-checklist-{feature}.md`의 `## 7. 시간 측정` 표 `구현` 구간 cell과 게이트(4-1 중계 / 4-4 dev 링크) 항목을 갱신합니다.

---

## Step 1 — 타입 정의

Spec 섹션 3 (Architecture)를 기반으로 타입을 먼저 정의합니다.
타입은 테스트가 필요 없지만, 이후 모든 구현의 기반이 됩니다.

> `create-component`의 **[2] 입력**과 **[3] 출력** 정의를 기반으로 작성합니다.

```ts
// src/features/{name}/types.ts 또는 src/constants/{name}.types.ts
```

- [ ] Spec의 모든 타입이 정의되었는가?
- [ ] `create-component`의 [2] 입력 / [3] 출력 정의와 일치하는가?
- [ ] 타입이 `src/features/{name}/types.ts`에 정의되었는가?
- [ ] `any` 타입이 없는가?

---

## Step 2 — Query / Mutation 훅 + 테스트

### 2-1. Query 테스트 먼저 작성

Spec 섹션 6 (Testing)의 단위 테스트 시나리오를 기반으로 작성합니다.

```ts
// src/features/{name}/apis/queries/ 또는 apis/mutations/queries/use{Name}Query.test.ts
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createWrapper } from '../testUtils'
import { use{Name}Query } from './use{Name}Query'

const server = setupServer(
  http.get('/api/{endpoint}', () => {
    return HttpResponse.json({ /* mock data */ })
  })
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('use{Name}Query', () => {
  it('데이터를 정상적으로 반환한다', async () => {
    const { result } = renderHook(() => use{Name}Query(), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeDefined()
  })

  it('서버 에러 시 isError가 true이다', async () => {
    server.use(
      http.get('/api/{endpoint}', () => HttpResponse.error())
    )
    const { result } = renderHook(() => use{Name}Query(), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
```

### 2-2. Query 훅 구현

```ts
// src/features/{name}/apis/queries/ 또는 apis/mutations/queries/use{Name}Query.ts
import { useQuery } from '@tanstack/react-query'
import { axiosInstance } from '@/app/apis'
import type { {EntityName} } from '@/features/{name}/types'

export const {name}Keys = {
  all: ['{name}'] as const,
  lists: () => [...{name}Keys.all, 'list'] as const,
  detail: (id: string) => [...{name}Keys.all, 'detail', id] as const,
}

export const use{Name}Query = () =>
  useQuery({
    queryKey: {name}Keys.lists(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<{EntityName}[]>('/api/{endpoint}')
      return data
    },
  })
```

### 2-3. Mutation 테스트 및 구현 (mutation이 필요한 경우)

```ts
// src/features/{name}/apis/queries/ 또는 apis/mutations/mutations/use{Name}Mutation.test.ts
import { renderHook } from '@testing-library/react'
import { createWrapper } from '../testUtils'
import { use{Name}Mutation } from './use{Name}Mutation'

describe('use{Name}Mutation', () => {
  it('mutation 함수가 존재한다', () => {
    const { result } = renderHook(() => use{Name}Mutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current.mutate).toBeDefined()
  })
})
```

```ts
// src/features/{name}/apis/queries/ 또는 apis/mutations/mutations/use{Name}Mutation.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { axiosInstance } from '@/app/apis'
import { {name}Keys } from '../queries/use{Name}Query'

export const use{Name}Mutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: unknown) => {
      const { data: result } = await axiosInstance.post('/api/{endpoint}', data)
      return result
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: {name}Keys.all })
    },
  })
}
```

### 2-4. 테스트 통과 확인

```bash
pnpm exec vitest run src/features/{name}/apis/
```

- [ ] 테스트 파일이 구현 파일보다 먼저 생성되었는가?
- [ ] 모든 테스트가 통과했는가?

---

## Step 3 — hooks (비즈니스 로직) + 테스트

```ts
// src/features/{name}/hooks/use{FeatureName}.test.ts
import { renderHook } from '@testing-library/react'
import { createWrapper } from '../testUtils'
import { use{FeatureName} } from './use{FeatureName}'

describe('use{FeatureName}', () => {
  it('초기 상태가 올바르다', () => {
    const { result } = renderHook(() => use{FeatureName}(), {
      wrapper: createWrapper(),
    })
    // 초기 상태 검증
  })
})
```

```ts
// src/features/{name}/hooks/use{FeatureName}.ts
export const use{FeatureName} = () => {
  // 비즈니스 로직

  return {
    // 반환값
  }
}
```

- [ ] 테스트가 먼저 작성되었는가?
- [ ] 모든 테스트가 통과했는가?

---

## Step 4 — UI 컴포넌트 + 테스트

### 4-1. 테스트 먼저 작성

```tsx
// src/features/{name}/components/{Name}.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createWrapper } from '../testUtils'
import { {Name} } from './{Name}'

describe('{Name}', () => {
  it('데이터 로딩 중 로딩 UI를 표시한다', () => {
    render(<{Name} />, { wrapper: createWrapper() })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('데이터 로드 완료 후 목록을 표시한다', async () => {
    render(<{Name} />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText(/* expected text */)).toBeInTheDocument()
    })
  })

  it('에러 발생 시 에러 메시지를 표시한다', async () => {
    render(<{Name} />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })
})
```

### 4-2. 컴포넌트 구현

```tsx
// src/features/{name}/components/{Name}.tsx
```

> **@genai/ui 의무 사용 — 직접 만들지 마세요. (`rules/07-design.md`, `rules/05-frontend-conventions.md`)**
> UI를 만들기 전에 **`@genai/ui`가 제공하는 컴포넌트를 먼저 확인**하고, 존재하면 **무조건 그것을 사용**합니다. 직접 새로 만들거나 네이티브 태그로 재구현하지 않습니다.
> 버튼·입력·모달은 예시일 뿐입니다 — **`@genai/ui`에 있는 모든 재사용 컴포넌트가 대상**입니다(탭, 셀렉트, 체크박스, 토스트, 테이블, 카드, 뱃지, 스피너, 툴팁 등).
> ```tsx
> // ✅ GOOD — @genai/ui에 있으면 무조건 import
> import { Button, Input, Modal } from '@genai/ui'
> // ❌ BAD — @genai/ui에 존재하는데 네이티브 태그로 직접 만들거나 로컬 컴포넌트로 재구현
> ```
> `@genai/ui`에 **없는** 컴포넌트만 `src/features/{name}/components/`에 만들고, Tailwind 유틸리티로 스타일링합니다.
> 폼은 `useState`가 아니라 React Hook Form을 사용합니다.

- [ ] 테스트가 먼저 작성되었는가?
- [ ] Spec 시나리오의 모든 케이스가 테스트에 포함되었는가?
- [ ] 구현 전 `@genai/ui` 제공 컴포넌트를 확인하고, 존재하는 것은 모두 `@genai/ui`에서 가져왔는가? (직접 재구현하지 않았는가?)
- [ ] 기본 디자인 검증을 했는가? (카드 배경·여백·정렬·대비 — `rules/07-design.md`의 "기본 디자인 검증")
- [ ] 모든 테스트가 통과했는가?

---

## Step 5 — 페이지 + 라우트 연결

pages 레이어는 feature 컴포넌트를 조합하는 얇은 레이어입니다.
비즈니스 로직 없이 feature를 import해서 배치하는 역할만 합니다.

### 5-1. 페이지 테스트

```tsx
// src/pages/{name}/{Name}Page.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { createWrapper } from '../testUtils'
import {Name}Page from './{Name}Page'

describe('{Name}Page', () => {
  it('페이지가 정상적으로 렌더링된다', () => {
    render(
      <MemoryRouter>
        <{Name}Page />
      </MemoryRouter>,
      { wrapper: createWrapper() }
    )
    expect(screen.getByRole('main')).toBeInTheDocument()
  })
})
```

### 5-2. 페이지 구현

```tsx
// src/pages/{name}/{Name}Page.tsx
import {Name} from '@/features/{name}'

const {Name}Page = () => {
  return <{Name} />
}

export default {Name}Page
```

### 5-3. 라우트 등록

`setup-router` command를 참조하여 라우트를 등록합니다.

> **메인 레이아웃(AppLayout)을 사용하는 PoC라면**, 새 라우트를 추가하지 않고 **기존 인덱스 라우트(`/`)의 `HomePage`를 이번 PoC 페이지로 덮어씁니다** (`init-poc` Step 5 1번 선택 참조). 추가 화면이 필요할 때만 children에 라우트를 더합니다.

- [ ] 테스트가 먼저 작성되었는가?
- [ ] 모든 테스트가 통과했는가?
- [ ] 라우트가 등록되었는가?

---

## Step 6 — 전체 검증

```bash
pnpm exec vitest run
```

- [ ] 모든 테스트가 통과했는가?
- [ ] 새로 작성한 테스트가 기존 테스트를 깨뜨리지 않았는가?
- [ ] Spec의 Goals 체크박스를 모두 체크했는가?
- [ ] 구현 중 Spec과 달라진 부분이 있다면 `sync-spec` command를 실행했는가?

---

## Step 7 — dev server 실행 + 리뷰 진행 게이트

테스트가 모두 통과하면, **여기서 바로 "완료"라고 끝내지 않습니다.** 아래 순서로 진행합니다.

### 7-1. 채비가 dev server를 직접 실행

사용자가 명령어를 입력할 필요 없이, 채비가 백그라운드로 dev server를 띄우고 **링크만** 안내합니다.

```bash
pnpm dev
```

> 백그라운드로 실행하고, 떠 있는 동안 사용자는 링크만 클릭하면 됩니다.
> 이미 실행 중이면 다시 띄우지 않고 기존 주소를 안내합니다.

### 7-2. 검증 + 리뷰 진행 여부 질문 (HARD GATE)

---
🟢 채비: 구현과 테스트가 끝났습니다. 직접 확인해보세요:)

        화면: http://localhost:5173

        확인 항목:
        {docs/tech-specs/{feature}.spec.md의 Goals를 체크리스트로}
        - [ ] {Goal 1}
        - [ ] {Goal 2}

        화면을 확인하셨으면, 이어서 **코드 리뷰를 진행할까요?**
        - "리뷰 진행" → 코드/성능 리뷰 후 완료 보고
        - "건너뛰기" → 리뷰 없이 마무리

---

> **HARD GATE — 건너뛰지 마세요.**
> 사용자가 "리뷰 진행" 또는 "건너뛰기"를 답하기 전까지 다음으로 넘어가지 않습니다.
> 리뷰 단계를 사용자에게 알리지 않고 자동으로 건너뛰거나 임의로 "완료" 보고하지 않습니다.

### 7-3. 분기

- **"리뷰 진행"** → `review-poc` command 실행 (`commands/poc/review-poc.md`)
- **"건너뛰기"** → 완료 보고로 마무리(리뷰 미실행으로 기록)

- [ ] dev server를 채비가 실행하고 링크를 안내했는가?
- [ ] 사용자에게 리뷰 진행 여부를 물었는가?
- [ ] 사용자 응답에 따라 분기했는가?

---

## 절대 하지 말아야 할 것

```
❌ 테스트 없이 구현 파일만 생성
❌ 테스트 실패 상태에서 다음 Step으로 진행
❌ Spec에 없는 기능을 임의로 추가 (Spec 먼저 수정 후 진행)
❌ plan-poc command 없이 implement-poc 실행
❌ 테스트를 나중에 작성하겠다고 미루기
❌ pages 레이어에 비즈니스 로직 작성 (features로 내릴 것)
```
