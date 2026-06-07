# Development Plan

## Current Focus

1. Keep the local-first document automation workflow stable.
2. Improve Workflow Builder creation, validation, and execution visibility.
3. Improve schema editing and AI-assisted draft generation.
4. Keep batch and workflow execution reliable at large document counts.
5. Keep public docs and examples aligned with runnable code.

## Recently Landed

- Workflow Builder save fallback for stale drafts.
- Compact execution status panel and removal of the canvas run banner.
- AI workflow draft generation from up to 10 sample images.
- Inline KIE schema editing inside Workflow Builder.
- Blank KIE nodes can now start a new schema draft directly inside Workflow Builder.
- Draft materialization for schema/checklist assets during workflow save.
- Public repository scope cleaned to focus on product features.

## Next Product Tasks

- Add stronger draft preview before applying AI-generated workflows.
- Add better duplicate-field and missing-schema warnings in Workflow Builder.
- Add fixture-based UI checks for AI workflow draft application.
- Improve export preset editing inside result review.
- Add more sample document templates with clear source notes.

## Working Rules

- Read code and docs before changing behavior.
- Keep changes narrowly scoped.
- Prefer existing helpers and patterns.
- Verify with backend tests, frontend build, and targeted smoke checks.
- Keep public-facing docs free of service-only implementation details.
