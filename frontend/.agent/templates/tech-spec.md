# {Feature Title}

> **파일 위치:** `docs/tech-specs/{feature-name}.spec.md`
> **상태:** `draft` | `approved` | `deprecated`
> **작성일:** YYYY-MM-DD
> **목적:** PoC / 데모

---

## 1. Goals / Non-Goals

### Goals

이번 PoC에서 반드시 동작해야 하는 것.
**측정 가능하고 관찰 가능한 형태로 작성한다.**
"어떤 입력을 했을 때 화면에 무엇이 보이면 완료인가"를 기준으로 한다.

```
✅ 올바른 예시
- PDF 파일을 업로드하면 파싱 결과 텍스트가 화면에 표시된다
- 목록에서 항목을 클릭하면 상세 페이지로 이동한다

❌ 잘못된 예시
- 파일 업로드가 된다
- 데이터가 잘 보인다
```

-
-
-

### Non-Goals

이번 범위에서 명시적으로 제외하는 것. 비워두지 않는다.

-
-
-

### 예상 결과

데모 완료 시 사용자가 경험하게 될 것을 자연어로 서술한다.
"~하면 ~가 된다" 형태로 1~3문장 작성한다.

-

---

## 2. User Flow

데모에서 보여줄 흐름을 순서대로 작성한다.

1.
2.
3.

---

## 3. Architecture

### Component Tree

데이터를 소유하는 컴포넌트와 props만 받는 컴포넌트를 구분한다.

```
{PageName}Page
  └─ {FeatureName}       ← query owner
       ├─ {ComponentA}   (props only)
       └─ {ComponentB}   (props only)
```

### State

| 상태 | 종류 | 위치 |
|------|------|------|
| {데이터} | 서버 (TanStack Query) | `features/{name}/apis/queries/` |
| {UI 상태} | 클라이언트 (Context / useState) | `features/{name}/hooks/` |

---

## 4. API Contract

> API 연동이 없으면 이 섹션을 삭제한다.

#### {METHOD} {/endpoint}

| 항목 | 내용 |
|------|------|
| 설명 | |
| Request | `{}` |
| Response | `{}` |
| Mock 필요 여부 | Yes / No |

---

## 5. Edge Cases

PoC에서 반드시 처리해야 할 최소한의 예외 상황.

| 케이스 | 대응 방식 |
|--------|-----------|
| 데이터 없음 (empty state) | |
| 로딩 중 | |
| API 에러 | |

---

## 6. Testing

> `implement` command 실행 전 반드시 작성. 비어있으면 implement 실행 불가.

### Unit Test

-
-

### Integration Test

-
-

---

## 7. Open Questions

결정되지 않았거나 데모 전에 확인이 필요한 것.

-
-
