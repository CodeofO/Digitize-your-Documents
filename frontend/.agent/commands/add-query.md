# Command: add-query

> TanStack Query 훅을 추가하는 절차서입니다.
> 기본 useQuery / useMutation은 `create-component` command를 사용하세요.
> 이 command는 API 명세 기반 구현과 고도화 패턴이 필요할 때만 사용합니다.

---

## 구현 전 설계 정의 (REQUIRED)

> 훅을 작성하기 전에 아래 5가지를 정의합니다.
> API 명세(`docs/refs/api/`)가 있으면 명세에서 추출합니다.
> 명세에 없는 항목은 사용자에게 확인 후 진행합니다.

### [1] 기능 요구사항

```
- 이 훅이 반드시 해야 하는 일:
- happy path:
- 예외 상황 (API 에러, 네트워크 실패 등):
```

### [2] 입력

```
- 파라미터 타입:
- 필수 파라미터:
- 선택 파라미터:
- 유효성 조건 (enabled 조건 등):
- 빈 값 처리:
```

### [3] 출력

```
- 반환 타입 (API 응답 구조):
- 정렬/필터 기준: (서버 처리인지 클라이언트 처리인지)
- error 형식 (API 에러 코드, 메시지):
- empty 처리 (빈 배열 vs null):
```

### [4] 제약

```
- 정확성: (캐시 무효화 시점)
- 성능: (staleTime, gcTime 필요 여부)
- 일관성: (동일 리소스의 다른 훅과 Query Key 공유)
- 권한: (인증 토큰 필요 여부)
- 확장성: (페이지네이션, 필터 추가 가능성)
```

### [5] 변경 가능성

```
- 자주 바뀔 수 있는 정책: (정렬 기준, 페이지 크기 등)
- 분리해야 할 책임: (Query vs Mutation 경계)
- 필요한 패턴 후보: (Pagination / Infinite / Optimistic — PoC에 필요한지 확인)
```

---

## 핵심 원칙

> **API 명세가 있으면 명세를 최우선으로 따릅니다.**
> `docs/refs/api/`에 명세 파일이 있으면 반드시 먼저 읽고, 명세에 맞게 구현합니다.
> 명세에 없는 파라미터, 응답 구조, 에러 코드를 임의로 추가하지 않습니다.

> **PoC에서 필요하지 않은 패턴은 구현하지 않습니다.**
> 아래 패턴들은 명시적으로 요청받거나 데모 시나리오에 반드시 필요한 경우에만 구현합니다.
> 필요 여부가 불명확하면 사용자에게 확인 후 진행합니다.

---

## Step 1 — API 명세 확인

```
1. docs/refs/api/ 탐색
2. 해당 feature 관련 명세 파일 읽기
3. 없으면 사용자에게 API 스펙 확인 요청
```

명세에서 확인할 항목:

- [ ] Endpoint, Method
- [ ] Request params / body 구조
- [ ] Response 구조 및 타입
- [ ] 페이지네이션 방식 (page 기반? cursor 기반? 없음?)
- [ ] 에러 코드 및 처리 방식

명세 확인 후 **필요한 패턴만** 아래에서 선택합니다.

---

## Step 2 — 패턴 필요 여부 판단

| 패턴 | 구현 조건 |
|------|-----------|
| 기본 Query / Mutation | API 연동이 필요한 모든 경우 → `create-component` 참조 |
| [Pagination](#pagination) | API가 page 기반 응답을 지원하고, UI에 페이지 컨트롤이 있을 때 |
| [Infinite Scroll](#infinite-scroll) | API가 cursor 기반 응답을 지원하고, 더보기/무한스크롤 UI가 있을 때 |
| [Optimistic Update + 롤백](#optimistic-update--롤백) | 즉각적인 UI 반응이 데모에서 필요할 때만 |
| [Dependent Query](#dependent-query) | 이전 API 응답값이 다음 API 호출에 필요할 때 |
| [Parallel Query](#parallel-query) | 동시에 여러 독립적인 API를 호출해야 할 때 |

**PoC 기본값:** 기본 Query / Mutation만 구현. 나머지는 명시적 요청 시에만 추가.

---

## Pagination

> API 명세에서 `page`, `size` 파라미터와 `totalCount`, `totalPages` 응답이 확인된 경우에만 구현합니다.

**파일 위치:** `src/features/{name}/apis/queries/use{Name}ListQuery.ts`

```ts
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { api } from '@/app/apis'

// 명세의 실제 응답 구조로 교체
interface PaginationParams {
  page: number
  size: number
}

interface PaginatedResponse<T> {
  data: T[]
  totalCount: number
  totalPages: number
  currentPage: number
}

export const {name}Keys = {
  all: ['{name}'] as const,
  lists: () => [...{name}Keys.all, 'list'] as const,
  list: (params: PaginationParams) => [...{name}Keys.lists(), params] as const,
}

export const use{Name}ListQuery = (params: PaginationParams) =>
  useQuery({
    queryKey: {name}Keys.list(params),
    queryFn: async () => {
      const { data } = await api.get<PaginatedResponse<{Entity}>>(
        '/api/{endpoint}', // 명세의 실제 endpoint로 교체
        { params }
      )
      return data
    },
    placeholderData: keepPreviousData, // 페이지 전환 깜빡임 방지
  })
```

---

## Infinite Scroll

> API 명세에서 cursor 기반 응답(`nextCursor`, `hasMore`)이 확인된 경우에만 구현합니다.

**파일 위치:** `src/features/{name}/apis/queries/use{Name}InfiniteQuery.ts`

```ts
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '@/app/apis'

// 명세의 실제 cursor 필드명으로 교체
interface CursorResponse<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

export const use{Name}InfiniteQuery = () =>
  useInfiniteQuery({
    queryKey: [...{name}Keys.lists(), 'infinite'],
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<CursorResponse<{Entity}>>(
        '/api/{endpoint}',
        { params: { cursor: pageParam, size: 20 } }
      )
      return data
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
```

```tsx
// 컴포넌트에서 사용
const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = use{Name}InfiniteQuery()
const items = data?.pages.flatMap(page => page.data) ?? []
```

---

## Optimistic Update + 롤백

> 즉각적인 UI 반응이 데모에서 반드시 필요한 경우에만 구현합니다.
> API 응답이 빠르다면 일반 mutation으로 충분합니다.

**파일 위치:** `src/features/{name}/apis/mutations/use{Name}OptimisticMutation.ts`

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/app/apis'

export const use{Name}OptimisticMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch(`/api/{endpoint}/${id}`)
      return data
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: {name}Keys.lists() })
      const previousData = queryClient.getQueryData({name}Keys.lists())
      queryClient.setQueryData({name}Keys.lists(), (old: {Entity}[]) =>
        old.map(item => item.id === id ? { ...item, /* 변경 필드 */ } : item)
      )
      return { previousData }
    },
    onError: (_err, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData({name}Keys.lists(), context.previousData)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: {name}Keys.lists() })
    },
  })
}
```

**순서 반드시 준수:**
```
onMutate  → cancelQueries → snapshot → optimistic update → return context
onError   → snapshot으로 롤백
onSettled → invalidateQueries로 서버 동기화
```

---

## Dependent Query

> 이전 API 응답값이 다음 호출에 필요할 때만 구현합니다.

```ts
export const use{Name}DetailQuery = (parentId: string | undefined) =>
  useQuery({
    queryKey: [...{name}Keys.details(), parentId],
    queryFn: async () => {
      const { data } = await api.get(`/api/{endpoint}/${parentId}`)
      return data
    },
    enabled: !!parentId, // parentId 없으면 실행 안 함
  })
```

---

## Parallel Query

> 동시에 여러 독립적인 API를 호출해야 할 때만 구현합니다.

```ts
import { useQueries } from '@tanstack/react-query'

export const use{Name}ParallelQuery = (ids: string[]) =>
  useQueries({
    queries: ids.map(id => ({
      queryKey: [...{name}Keys.details(), id],
      queryFn: () => api.get(`/api/{endpoint}/${id}`).then(r => r.data),
    })),
  })
```

---

## Query Key 설계

```ts
export const {name}Keys = {
  all: ['{name}'] as const,
  lists: () => [...{name}Keys.all, 'list'] as const,
  list: (params: unknown) => [...{name}Keys.lists(), params] as const,
  details: () => [...{name}Keys.all, 'detail'] as const,
  detail: (id: string) => [...{name}Keys.details(), id] as const,
}
```

---

## 공통 체크리스트

- [ ] API 명세를 먼저 확인했는가?
- [ ] 명세에 없는 파라미터나 응답 구조를 임의로 추가하지 않았는가?
- [ ] PoC에 불필요한 패턴을 추가하지 않았는가?
- [ ] Query Key에 관련 파라미터가 모두 포함되었는가?
- [ ] 에러/로딩 상태 UI가 있는가?
