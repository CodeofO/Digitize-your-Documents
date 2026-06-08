# Backend — Refactor Plan

## Scope
- In: reusable backend boundaries for VLM settings, workflow graph rules, module result validation, workflow run state transitions, module job state transitions, repository ports, VLM provider adapters, local OpenAI-compatible raw JSON fallback, and domain value objects for schema/checklist/classifier definitions.
- Out: persistence schema changes, KIE image input business logic, workflow execution semantics, provider prompt behavior, frontend behavior.

## Behavior To Preserve
- Public API: existing settings, workflow, KIE, classification, required-check, and export endpoints.
- Domain rules: reasoning/thinking is off by default; workflow branch behavior is unchanged; required-check and classification validation outputs are unchanged; workflow run and module job status transitions preserve existing status values and side effects.
- Side effects: `.env` writes, background jobs, audit logs, storage writes, and VLM calls remain on existing execution paths.

## Characterization
- Baseline backend test suite passed before refactoring.
- Each cycle ran targeted tests before moving to the next cycle.

## Refactor Steps
1. Extracted `VlmInferenceParams` as an immutable value object for parsing, normalization, validation, and provider-specific inference parameter mapping.
2. Extracted `workflow_graph.py` for pure workflow graph construction, shape validation, branch selection, and summary derivation.
3. Extracted `module_validation.py` for classification and required-field result validation.
4. Split system/settings endpoints into `routers/system.py` and moved VLM settings orchestration into `services/vlm_settings.py`.
5. Added `WorkflowRunLifecycle` and `WorkflowRunApplicationService` to centralize workflow start, resume, pause, retry, cancel, and stop transitions.
6. Added `ModuleJobLifecycle` and applied it to classification, required-check, and workflow-triggered module job cancellation paths.
7. Added repository ports and SQLAlchemy repository adapters, then applied the workflow run repository to public workflow-run API paths.
8. Added VLM provider client adapters behind a common `invoke`/`ainvoke` interface while preserving provider-specific call implementations.
9. Added schema/checklist/classifier domain value objects and used them in KIE/module validation paths.
10. Split new tests into `tests/domain` and `tests/application`; added unit tests for workflow graph and domain value objects.
11. Added a local OpenAI-compatible raw JSON fallback path for `VLM_BASE_URL` calls and parser tests for local model whitespace/partial-JSON artifacts.

## Verification
- `./.venv/bin/python -m pytest backend/tests`: 150 passed.
- `npm run build --prefix frontend`: passed.
- `git diff --check`: passed.

## Risks
- `main.py` is smaller at the settings/workflow-run boundary but still mixes many document, batch, export, and maintenance routes.
- SQLAlchemy models are still persistence records; domain behavior is currently expressed as lifecycle/value-object modules operating on those records.
- Repository ports are introduced, but only workflow-run public API paths use them so far.
