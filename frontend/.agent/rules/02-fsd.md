# Rule 02 — 폴더 구조 및 레이어 규칙

> 이 프로젝트는 **Feature-based 구조**를 따릅니다.
> FSD 공식 문서와 다릅니다. 이 파일의 구조가 기준입니다.

---

## 계층별 역할

### `src/app/` — 앱 설정

```
src/app/
├── apis/       ← axios 인스턴스, API 클라이언트 설정
└── routes/     ← 라우트 정의 (createBrowserRouter)
```

**책임:** API 클라이언트 초기화, 라우팅 설정
**import 가능:** 모든 레이어
**import 금지:** 없음

---

### `src/pages/` — 페이지

```
src/pages/
└── {PageName}Page.tsx   ← 라우트에 대응하는 페이지
```

**책임:** 라우트 단위 페이지. feature 컴포넌트를 조합하는 얇은 레이어.
비즈니스 로직을 직접 작성하지 않습니다.

```tsx
// ✅ 올바른 패턴
import FileManager from '@/features/fileManager/FileManager'

const FileManagerPage = () => <FileManager />
export default FileManagerPage
```

---

### `src/features/` — 기능 모듈

```
src/features/
└── {featureName}/
    ├── apis/
    │   ├── mutations/    ← POST, PUT, DELETE (useMutation 훅)
    │   └── queries/      ← GET (useQuery 훅)
    ├── components/       ← 기능 전용 컴포넌트
    ├── contexts/         ← 기능 전용 Context (선택)
    ├── hooks/            ← 기능 전용 커스텀 훅
    ├── types.ts          ← 타입 정의
    ├── utils/            ← 유틸리티 함수
    └── {FeatureName}.tsx ← 기능 메인 컴포넌트
```

> `src/features/_template/`을 복사해서 새 feature를 시작합니다.

**책임:** 독립적인 기능 단위. 자체 API, 컴포넌트, 훅을 포함합니다.

---

### `src/components/` — 공통 컴포넌트

```
src/components/
└── {ComponentName}.tsx  ← 여러 feature에서 재사용되는 UI
```

**책임:** 도메인 로직 없는 순수 UI 컴포넌트.
> `@genai/ui`에 없는 컴포넌트만 여기에 만듭니다.

---

### `src/contexts/` — 전역 Context

```
src/contexts/
└── {Name}Provider.tsx   ← 인증, 토스트 등 앱 전역 상태
```

---

### `src/hooks/` — 전역 커스텀 훅

```
src/hooks/
└── use{HookName}.ts     ← 여러 feature에서 공유하는 훅
```

---

### `src/layouts/` — 레이아웃

```
src/layouts/
└── {LayoutName}.tsx     ← 공통 레이아웃 (헤더, 사이드바 포함)
```

---

### `src/lib/` — 라이브러리 설정

```
src/lib/
└── utils.ts             ← cn() 등 유틸 (clsx + tailwind-merge)
```

---

### `src/utils/` — 전역 유틸리티

```
src/utils/
└── {utilName}.ts        ← 범용 유틸 함수
```

---

### `src/constants/` — 상수

```
src/constants/
└── {name}.ts            ← 전역 상수, queryKeys 등
```

---

### `src/i18n/` — 다국어

```
src/i18n/
├── i18n.ts              ← i18next 초기화
└── locales/
    ├── ko.ts
    ├── en.ts
    └── ja.ts
```

---

## 파일 위치 결정 기준

| 상황 | 위치 |
|------|------|
| URL에 직접 대응하는 페이지 | `src/pages/` |
| 특정 기능의 API 호출 (GET) | `src/features/{name}/apis/queries/` |
| 특정 기능의 API 호출 (POST/PUT/DELETE) | `src/features/{name}/apis/mutations/` |
| 컴포넌트 (기본값) | `src/features/{name}/components/` |
| 기능 전용 상태/로직 훅 | `src/features/{name}/hooks/` |
| 여러 feature에서 공통으로 쓰는 컴포넌트만 | `src/components/` |
| 여러 feature에서 쓰는 훅 | `src/hooks/` |
| 앱 전역 상태 (인증, 토스트) | `src/contexts/` |
| axios 인스턴스, API 기본 설정 | `src/app/apis/` |
| 환경변수 상수 | `src/constants/` 또는 `src/lib/` |
| 어디에도 안 맞을 때 | `src/utils/`에 두고 나중에 올린다 |

---

## 경로 alias

```ts
// tsconfig.app.json 및 vite.config.ts에 설정됨
@/*  →  src/*
```

```tsx
// ✅ 올바른 import
import { Button } from '@genai/ui'
import { api } from '@/app/apis'
import FileManager from '@/features/fileManager/FileManager'

// ❌ 잘못된 import — 상대 경로 남용
import FileManager from '../../../features/fileManager/FileManager'
```
