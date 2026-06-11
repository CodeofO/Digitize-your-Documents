# Rule 01 — 프로젝트 개요 및 기술스택

## 프로젝트 성격

이 레포는 **데모 / PoC 전용**입니다. SaaS 프로덕션 코드베이스가 아닙니다.

- 빠른 프로토타이핑이 목표입니다
- 완벽한 최적화보다 **동작하는 결과물**이 우선입니다
- 단, 코드 구조와 컨벤션은 SaaS 레포 기준을 유지합니다

---

## 레포 구조

```
/                          ← 레포 루트 (에이전트 구성 위치)
├── .agent/                ← AI 에이전트 설정 (Rules/Commands/Subagents/Skills)
├── src/                   ← React 앱 소스 (Vite 기반)
│   ├── app/               ← API 클라이언트, 라우트 정의
│   ├── assets/            ← 폰트/아이콘/이미지
│   ├── components/        ← 공통 재사용 컴포넌트
│   ├── constants/         ← 상수 정의
│   ├── contexts/          ← React Context (전역 상태)
│   ├── features/          ← 기능별 독립 모듈
│   │   └── [featureName]/ ← _template/ 복사 후 사용
│   │       ├── apis/
│   │       │   ├── mutations/
│   │       │   └── queries/
│   │       ├── components/
│   │       ├── hooks/
│   │       ├── types.ts
│   │       └── utils/
│   ├── hooks/             ← 전역 커스텀 훅
│   ├── i18n/              ← 다국어 설정 (구조는 항상 유지, 패키지는 요청 시 설치)
│   ├── layouts/           ← 레이아웃 컴포넌트
│   ├── lib/               ← 라이브러리 설정
│   ├── pages/             ← 페이지 컴포넌트 (라우트 단위)
│   ├── utils/             ← 전역 유틸리티
│   └── main.tsx           ← 엔트리 포인트
├── docs/tech-specs/       ← PoC Tech Spec 문서
├── docs/refs/             ← 참조 문서 (gitignore)
├── TECHSTACK.md           ← 기술스택 가이드 (agent 필독)
├── CLAUDE.md              ← Claude Code 진입점
├── AGENTS.md              ← Codex 진입점
└── .cursor/rules/         ← Cursor 진입점
```

---

## 계층 구조

```
Pages (라우트)
  └─ 페이지 컴포넌트만, 비즈니스 로직 최소화
       ↓
Features (기능 모듈)
  └─ 독립적 기능 단위, 자체 API/컴포넌트/훅 포함
       ↓
Components (공통 컴포넌트)
  └─ 재사용 가능한 UI 컴포넌트
       ↓
App (설정)
  └─ API 클라이언트, 라우팅 설정
```

---

## 기술스택 (핵심)

| 패키지 | 버전 | 용도 |
|--------|------|------|
| react | ^19.2.6 | UI 프레임워크 |
| typescript | ~6.0.2 | 타입 안전성 |
| vite | ^8.0.12 | 빌드 도구 |
| react-router-dom | ^7.x | 클라이언트 라우팅 |
| tailwindcss | ^3.4.x | 스타일링 |
| @genai/ui | ^0.1.1 | 공유 UI 컴포넌트 |

> 상세 버전 및 선택 설치 패키지는 `TECHSTACK.md`와 `rules/04-dependencies.md`를 참조하세요.

---

## 패키지 매니저

```bash
pnpm   # 반드시 pnpm 사용. npm, yarn 사용 금지.
```

---

## 공유 UI

| 패키지 | 용도 |
|--------|------|
| `@genai/ui` | 공통 컴포넌트 (Button, Modal, ScrollArea 등) |

```tsx
import { Button } from '@genai/ui'
```

> `@genai/ui`에 없는 컴포넌트만 `src/components/`에 로컬로 추가합니다.

---

## 선택 설치 패키지 (필요 시)

| 패키지 | 용도 | 설치 조건 |
|--------|------|-----------|
| @tanstack/react-query | 서버 상태 관리 | API 호출이 필요한 경우 |
| react-hook-form + zod | 폼 관리 + 유효성 검사 | 입력 폼이 있는 경우 |
| axios | HTTP 클라이언트 | API 연동 시 |
| dayjs | 날짜 처리 | 날짜 포맷/계산 시 |
| i18next + react-i18next | 다국어 | 국제화 필요 시 |

> 설치 전 `TECHSTACK.md` 섹션 5(선택 설치 패키지)의 예시 코드를 먼저 읽습니다.

---

## 핵심 제약

```
❌ any 타입 사용
❌ @genai/ui 패키지 직접 수정
❌ 04-dependencies.md에 없는 버전으로 패키지 설치
❌ npm, yarn 사용 (pnpm만 허용)
❌ console.log를 프로덕션 코드에 남기기
❌ 비즈니스 로직을 pages에 직접 작성
❌ 인라인 style={{ color: '#...' }} — 하드코딩 금지

✅ 새 파일 생성 시 features/ 또는 적절한 레이어 위치 먼저 결정
✅ 새 패키지 설치 전 TECHSTACK.md + 04-dependencies.md 버전 확인
✅ 컴포넌트 props는 항상 TypeScript interface로 정의
✅ 비동기 함수는 항상 try-catch로 처리
```
