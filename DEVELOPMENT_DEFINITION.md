# Development Definition

## Product Shape

The project is a document automation workspace for repeatable document operations:

- Upload and organize source documents.
- Convert documents into page images when needed.
- Define schemas and extract key information with a VLM.
- Classify documents into named classes.
- Check required fields and evidence.
- Compose repeatable workflows visually.
- Execute workflows over selected or uploaded documents.
- Review results and export JSON, CSV, or XLSX files.

## Public Feature Contract

The public application starts directly in the workspace. Runtime settings, document processing, workflow building, and export features are available without service gating.

The AI workflow draft API accepts up to 10 PNG/JPG/JPEG images, stores them only in temporary processing space for the request, and returns a draft workflow plus schema/checklist suggestions. Persisting sample documents is a separate explicit frontend action.

Workflow Builder supports node asset editing for KIE schemas, classifier classes, and required-field checklists. Asset editors use module-style table layouts and float over the canvas so node selection does not shift the graph. A KIE node can start from an AI-generated draft, an existing saved schema, or a new blank schema draft created inside the builder. Saving or running a workflow materializes draft schemas and checklists before persisting the workflow definition.

The VLM settings surface supports external APIs and local OpenAI-compatible servers through `VLM_BASE_URL`. Inference parameters are configured through `VLM_INFERENCE_PARAMS`; reasoning/thinking defaults to off and is provider-routed by the backend. Slow local models must not be failed by a frontend-only timeout while the backend job is still running. Provider request timeout remains controlled by `VLM_TIMEOUT_SECONDS`.

Local OpenAI-compatible servers do not always enforce `response_format=json_schema` even when they accept the parameter. For `VLM_BASE_URL` calls, the backend receives raw `message.content`, parses the first JSON object, and repairs limited local-model artifacts such as markdown fences, extra surrounding text, long trailing whitespace, and simple missing closing braces. Responses that still cannot become a JSON object fail explicitly as `VLM_RESPONSE_INVALID_JSON`.

## Core API Groups

| Area | Representative endpoints |
| --- | --- |
| System | `GET /api/health`, `GET /api/system/status` |
| Settings | `GET /api/settings/vlm`, `PUT /api/settings/vlm` |
| Documents | `POST /api/documents`, `GET /api/documents`, document library endpoints |
| Raw extraction | `POST /api/raw-extractions`, `GET /api/raw-extractions` |
| Schemas/KIE | schema CRUD, recommendation, extraction job, batch endpoints |
| Classifier | classifier CRUD, classification job and batch endpoints |
| Required checks | checklist CRUD, check job and batch endpoints |
| Workflows | workflow CRUD, AI draft, run init/upload/enqueue/retry/cancel endpoints |
| Export | export presets and export jobs |

## Verification Baseline

Before publishing feature work:

- Run backend tests.
- Run frontend build.
- Run `git diff --check`.
- Use mock VLM smoke tests for high-volume or UI flows.
- Use browser verification for significant frontend changes.
