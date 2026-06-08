# Project Insights

## Product Insight

Document automation is most useful when individual AI modules are not isolated tools. The core value of this workspace is the shared document library, reusable schemas/classifiers/checklists, and workflow execution layer that turns one-off extraction into repeatable operations.

## Architecture Insight

The system should keep long-running work in backend jobs and let the frontend follow job state. This is especially important for local VLMs, where inference latency can vary from seconds to many minutes. Frontend-only timeouts create false failures and should be avoided for active jobs.

## VLM Integration Insight

Hosted APIs and local OpenAI-compatible servers need different defaults:

- Hosted APIs benefit from provider quota controls and moderate request timeout values.
- Local large models benefit from longer `VLM_TIMEOUT_SECONDS`, smaller `KIE_FIELD_GROUP_SIZE`, and lower `VLM_MAX_CONCURRENT_REQUESTS`.
- `base_url` support should not imply a real API key is required; local OpenAI-compatible servers often accept a dummy key.

## Workflow Builder Insight

Users need to inspect and edit the assets behind nodes, not just connect boxes. Schema fields, classifier classes, and checklist items should use consistent table-based editors so users can understand the data contract that each node will execute.

## Review UX Insight

Extraction output is not just a value table. Confidence, evidence, raw output, user corrections, and review state must stay tied to the same result id. Mixing stale local edits with new model output creates subtle trust failures.

## Demo Insight

The demo workflow should be realistic enough to teach the system shape immediately:

- Seeded documents, schema, classifier, checklist, and workflow should be present on first use.
- Canvas nodes should be compact and readable.
- README screenshots should come from runnable smoke flows, not manually assembled mock images.
