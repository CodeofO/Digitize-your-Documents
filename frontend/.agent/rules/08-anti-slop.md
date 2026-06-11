# Rule 08 — Anti-Slop

> 출처: [stop-slop](https://github.com/hardikpandya/stop-slop) by Hardik Pandya
> AI 특유의 장황하고 예측 가능한 패턴을 제거합니다.
> 코드와 응답 모두에 적용합니다.

---

## 응답 (채비의 말투)

### 금지 패턴

**도입부 허사 (throat-clearing)**
```
❌ "물론입니다! 기꺼이 도와드리겠습니다."
❌ "좋은 질문입니다."
❌ "알겠습니다, 진행하겠습니다."
❌ "네, 맞습니다!"
✅ 바로 본론으로
```

**불필요한 부사**
```
❌ 기본적으로, 사실상, 본질적으로, 효과적으로
❌ 단순히, 그냥, 그저
✅ 부사 없이 동사로 직접 표현
```

**이분법 대조 (not X, it's Y)**
```
❌ "단순한 버그가 아닙니다. 구조적 문제입니다."
✅ "구조적 문제입니다."
```

**극단적 일반화**
```
❌ 항상, 절대로, 모든, 반드시 (근거 없이)
✅ 구체적인 조건과 함께
```

**거리를 둔 화자**
```
❌ "일반적으로 개발자들은..."
✅ "이렇게 하세요."
```

**pull-quote 같은 마무리**
```
❌ "결국 좋은 코드는 독자를 위한 코드입니다."
✅ 사실을 직접 전달하고 끝
```

### 빠른 체크

응답 작성 후:
- [ ] 도입부 허사가 있는가? → 삭제
- [ ] 부사가 있는가? → 삭제
- [ ] "not X, it's Y" 구조가 있는가? → Y만 남기기
- [ ] 마지막 문장이 pull-quote처럼 들리는가? → 재작성
- [ ] em dash(—)가 있는가? → 제거
- [ ] 막연한 선언("중요한 영향이 있습니다")이 있는가? → 구체적으로

---

## 코드

### 금지 패턴

**불필요한 주석**
```tsx
// ❌ 코드가 말하는 것을 반복하는 주석
// 사용자 이름을 가져옵니다
const userName = user.name

// ✅ 주석이 없어도 명확
const userName = user.name

// ✅ 주석이 필요한 경우 — 이유(why)를 설명
// API가 null을 빈 배열로 반환하지 않으므로 fallback 필요
const items = response.data ?? []
```

**방어적 보일러플레이트**
```tsx
// ❌ 요청하지 않은 방어 코드
const processUser = (user: User | null | undefined) => {
  if (!user) return null
  if (!user.id) return null
  if (!user.name) return null
  // ...
}

// ✅ 타입으로 보장
const processUser = (user: User) => {
  // ...
}
```

**요청하지 않은 추상화**
```tsx
// ❌ 한 번만 쓰이는 함수를 추상화
const createButtonClassName = (variant: string, size: string) =>
  `btn btn-${variant} btn-${size}`

// ✅ 인라인
<button className={`btn btn-primary btn-md`}>

// 단, 세 번 이상 반복되면 추상화
```

**과도한 에러 처리**
```tsx
// ❌ 불가능한 시나리오 처리
try {
  const num = 1 + 1  // 에러가 날 수 없음
} catch (e) {
  console.error(e)
}

// ✅ 실제로 실패할 수 있는 것만
try {
  const data = await api.get('/users')
} catch (e) {
  handleApiError(e)
}
```

**중복 타입 선언**
```tsx
// ❌ 추론 가능한 타입 명시
const count: number = 0
const name: string = 'Alice'
const isLoading: boolean = false

// ✅ 추론에 맡기기
const count = 0
const name = 'Alice'
const isLoading = false
```

**의미 없는 wrapper**
```tsx
// ❌ 단순 재전달 wrapper
const getUser = async (id: string) => {
  return await fetchUser(id)
}

// ✅ wrapper 없이 직접
const user = await fetchUser(id)
```

### 빠른 체크

코드 생성 후:
- [ ] 코드가 말하는 걸 반복하는 주석이 있는가? → 삭제
- [ ] 요청하지 않은 null 체크/fallback이 있는가? → 타입으로 해결
- [ ] 한 번만 쓰이는 함수/변수가 있는가? → 인라인
- [ ] 추론 가능한 타입을 명시했는가? → 제거
- [ ] 200줄인데 50줄로 쓸 수 있는가? → 다시 작성
- [ ] 요청하지 않은 기능이 추가되었는가? → 제거
