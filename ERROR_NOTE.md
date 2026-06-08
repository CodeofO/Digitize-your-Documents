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
- Runtime settings expose `VLM_TIMEOUT_SECONDS`; local OpenAI-compatible runs can also lower `KIE_FIELD_GROUP_SIZE`.

Verification:

- Frontend build passed.
- Backend API tests passed.
- PoC UI smoke generated current workflow screenshots.

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
