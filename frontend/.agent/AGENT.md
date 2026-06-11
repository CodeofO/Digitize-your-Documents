# Agent Configuration

> **모든 AI 에이전트는 작업 시작 전 이 파일과 하위 rules를 반드시 읽어야 합니다.**
> Every AI agent (Claude Code, Cursor, Codex, Gemini CLI, etc.) must read this file before starting any task.

---

## 이 레포지토리의 목적

Agent팀 AI 리서처들의 데모 / PoC FE 개발을 지원하기 위한 **React + TypeScript + Vite 기반 FE Boilerplate**.

SaaS 메인 서비스와 결이 다른 독립적인 데모/PoC 환경을 빠르게 구성할 수 있도록 설계되었습니다.

---

## 필수 Rules 읽기 순서

아래 순서로 모든 파일을 읽은 뒤 작업을 시작하세요.

| 순서 | 파일 | 내용 |
|------|------|------|
| 0 | `TECHSTACK.md` (레포 루트) | 기술스택 전체 가이드 — 가장 먼저 읽기 |
| 1 | [rules/01-project.md](rules/01-project.md) | 프로젝트 개요, 기술스택, 핵심 제약 |
| 2 | [rules/02-fsd.md](rules/02-fsd.md) | 폴더 구조 및 레이어 규칙 |
| 3 | [rules/03-naming.md](rules/03-naming.md) | 네이밍 컨벤션 |
| 4 | [rules/04-dependencies.md](rules/04-dependencies.md) | 의존성 버전 고정 규칙 |
| 5 | [rules/05-frontend-conventions.md](rules/05-frontend-conventions.md) | 폼, 상태, 데이터 페칭 패턴 |
| 6 | [rules/06-llm-behavior.md](rules/06-llm-behavior.md) | LLM 코딩 행동 원칙 |
| 7 | [rules/07-design.md](rules/07-design.md) | 디자인 소스 선언 및 Tailwind 설정 |
| 8 | [rules/08-anti-slop.md](rules/08-anti-slop.md) | AI slop 패턴 방지 (응답 + 코드) |
| 9 | [rules/09-language.md](rules/09-language.md) | 응답 언어 — 한국어 기본 |

---

## 사용 가능한 Commands

반복 작업은 아래 command를 호출하세요.

**개발 사이클 순서대로 실행합니다.**

> **Cursor 사용자:** `.cursor/commands/`의 slash command로 직접 호출 가능합니다.
> **Claude Code / Codex 사용자:** `/Chaebi {요청}`으로 호출합니다.

| 순서 | Command | Cursor | 설명 | 상태 |
|------|---------|------|------|
| 1 | [commands/poc/plan-poc.md](commands/poc/plan-poc.md) | PoC 시작 — 대화 흐름 오케스트레이션 (슈퍼 에이전트) | ✅ 완성 |
| 1-1 | [commands/poc/init-poc.md](commands/poc/init-poc.md) | 프로젝트 초기화 → build → dev server (plan-poc가 자동 호출) | ✅ 완성 |
| 2 | [commands/poc/implement-poc.md](commands/poc/implement-poc.md) | Spec 기반 구현 + 테스트 → review-poc 위임 | ✅ 완성 |
| 2-1 | [commands/poc/review-poc.md](commands/poc/review-poc.md) | 사용자 검증 → QA/PERF 리뷰 → 완료 보고 (채비 오케스트레이션) | ✅ 완성 |
| 3 | [commands/poc/sync-spec.md](commands/poc/sync-spec.md) | 진행 중 변경사항 Spec 반영 + 구조화 보고 (사용자 호출) | ✅ 완성 |
| 3-auto | [commands/poc/auto-sync-spec.md](commands/poc/auto-sync-spec.md) | 구현 중 불일치 자동 감지 → Spec 즉시 수정 (AI 자동) | ✅ 완성 |
| - | [commands/setup-router.md](commands/setup-router.md) | React Router DOM 라우트 추가 | ✅ 완성 |
| - | [commands/create-component.md](commands/create-component.md) | FSD 기반 컴포넌트 생성 | ✅ 완성 |
| - | [commands/add-query.md](commands/add-query.md) | TanStack Query 고도화 패턴 | ✅ 완성 |

---

## Sub-agents

| Agent | 역할 | 호출 |
|-------|------|------|
| [subagents/chaebi.md](subagents/chaebi.md) | PoC FE 개발 전담 오케스트레이터 | Cursor: `/Chaebi` / Claude Code: `/chaebi` / Codex: `/Chaebi` |
| [subagents/reviewers/poc/code-reviewer.md](subagents/reviewers/poc/code-reviewer.md) | 코드 리뷰 (React/TS/접근성) | review-poc 자동 호출 |
| [subagents/reviewers/poc/perf-reviewer.md](subagents/reviewers/poc/perf-reviewer.md) | 성능/안정성 리뷰 | review-poc 자동 호출 |

> Cursor Sub-agent 파일: `.cursor/agents/chaebi.md`
> Claude Code Sub-agent 파일: `.claude/agents/chaebi.md`, `.claude/agents/code-reviewer.md`, `.claude/agents/perf-reviewer.md`

---

## Tech Spec 템플릿

| 파일 | 설명 |
|------|------|
| [templates/tech-spec.md](templates/tech-spec.md) | PoC 전용 Tech Spec 템플릿 (`docs/tech-specs/` 폴더에 생성) |

---

## Skills

코드 리뷰, 리팩토링, 품질 개선 요청 시 on-demand로 참조합니다. 항상 적용되지 않습니다.

| Skill | 설명 | 진입점 |
|-------|------|--------|
| toss-frontend-fundamentals | 코드 품질 가이드 (가독성, 예측 가능성, 응집도, 결합도) | [skills/toss-frontend-fundamentals/SKILL.md](skills/toss-frontend-fundamentals/SKILL.md) |
| figma-to-component | Figma URL → React 컴포넌트 구현 + 2회 px 단위 정합성 검증 | [skills/figma-to-component/SKILL.md](skills/figma-to-component/SKILL.md) |

---

## 핵심 원칙 요약 (상세 내용은 각 rules 파일 참조)

1. **FSD 레이어를 반드시 준수한다** — 상위 레이어가 하위 레이어를 import하는 것은 금지
2. **의존성 버전을 임의로 올리지 않는다** — `rules/04-dependencies.md`의 버전 목록이 기준
3. **새 패키지 설치 전 반드시 확인한다** — `04-dependencies.md`에 없으면 사용자에게 물어본다
4. **타입은 `any` 금지** — 불명확한 타입은 `unknown`으로 선언하고 narrowing한다
5. **컴포넌트는 단일 책임** — 비즈니스 로직과 UI 렌더링을 같은 컴포넌트에 두지 않는다
