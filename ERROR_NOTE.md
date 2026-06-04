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
