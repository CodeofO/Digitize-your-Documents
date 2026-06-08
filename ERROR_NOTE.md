# Error Notes

This file records public, feature-facing issues and fixes.

## 2026-06-04 - Public Feature Snapshot Cleanup

Problem:

- The private workspace included service-readiness material that should not be mirrored into the public repository.

Cause:

- Recent development combined product features with service preparation work in the same private branch.

Fix:

- Created a public snapshot from the latest feature tree.
- Removed service-only UI/API/docs/scripts from the public branch.
- Kept upload, KIE, classifier, required checks, workflow builder, AI workflow draft, execution, review, and export features.

Verification:

- Backend tests and frontend build should be run before publishing the public branch.

## 2026-06-04 - AI Workflow Draft Audit Event

Problem:

- The AI workflow draft endpoint could fail when the audit event entity id was missing.

Cause:

- Audit events require a non-null entity id.

Fix:

- The draft endpoint now records a generated draft entity id while keeping sample images temporary by default.

## 2026-06-08 - Local VLM KIE Polling Timeout

Problem:

- KIE single-run review could show "제한 시간 안에 추출이 끝나지 않았습니다" while a locally served large VLM was still using GPU and generating.

Cause:

- The frontend `pollJob` helper stopped after roughly 60 seconds even though the backend extraction job was still `queued` or `running`.
- Local 26B-class VLM inference can be much slower than hosted APIs, especially when KIE field groups are large.

Fix:

- KIE single-run polling now follows backend job state until a terminal status is returned.
- The busy message shows elapsed time after 60 seconds instead of failing locally.
- Runtime settings expose `VLM_TIMEOUT_SECONDS`; local OpenAI-compatible runs can also lower `KIE_FIELD_GROUP_SIZE`. `VLM_INFERENCE_PARAMS` defaults reasoning/thinking to off so local VLM smoke tests do not accidentally enable provider reasoning modes.

Verification:

- Frontend build passed.
- Backend API tests passed.
- PoC UI smoke generated current workflow screenshots.

## 2026-06-08 - Local VLM OpenAI-Compatible JSON Response Not Accepted

Problem:

- A locally served VLM returned an HTTP chat completion, but the KIE screen stayed in `running`/polling and the backend did not produce an extraction result.

Cause:

- The local OpenAI-compatible server accepted `response_format=json_schema`, but the model generated raw `message.content` that only partially formed JSON and then produced thousands of whitespace tokens.
- LangChain strict structured output could not coerce that response into the expected object, so the extraction worker treated it as a provider response failure instead of a completed KIE result.

Fix:

- When `VLM_BASE_URL` is set, the OpenAI-compatible adapter now uses a local-friendly raw JSON path instead of relying only on provider-side strict `json_schema`.
- The backend parses raw `message.content` and tolerates markdown fences, extra surrounding text, long trailing whitespace, and simple missing closing braces/brackets.
- If the response still cannot be parsed, the job fails with `VLM_RESPONSE_INVALID_JSON` so the operator can tune the local model/server instead of waiting on repeated heavy retries.

Verification:

- Added local VLM JSON parser tests for markdown JSON, embedded JSON, whitespace-loop/missing-brace recovery, invalid text, and local `base_url` routing.
- `./.venv/bin/python -m pytest backend/tests`: 150 passed.
- `git diff --check`: passed.

## 2026-06-08 - KIE Review Mixed State And Low Confidence

Problem:

- A KIE result could display raw model output and table values inconsistently after result transitions.
- Low-confidence extraction values could still appear as normal/completed.

Cause:

- Review edits were not scoped to the active extraction result id.
- Backend validation only warned on malformed confidence, not low confidence.

Fix:

- Review edits are now bound to `result.id` and reset when a different result is loaded.
- `confidence < 0.75` adds `low_confidence`, making the job/result `needs_review`.
