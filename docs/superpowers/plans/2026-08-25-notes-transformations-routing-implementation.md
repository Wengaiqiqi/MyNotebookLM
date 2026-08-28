# MyNotebookLM Notes, Transformations and Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Apply test-driven-development and independent review per task.

**Goal:** Add complete research notes, AI titles, reusable transformations/insights and transparent multi-model routing with narrowly classified fallback.

**Architecture:** Notes and rules are ordinary SQLite business entities. Transformations are durable tasks that assemble bounded source/message/note input, call the same generation contract as chat and persist idempotent insights. A routing service resolves explicit overrides, task defaults and ordered fallbacks; it records every attempt and never crosses embedding spaces.

**Tech Stack:** Existing Electron/TypeScript/SQLite/provider/task stack; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- Notes store Markdown text but never execute embedded HTML/script/template code.
- AI title is explicit and non-destructive: failure keeps current title/body.
- Built-ins are summary, key points and Q&A in both languages.
- Custom rule placeholders are exactly `{{content}}`, `{{source_title}}`, `{{project_name}}`, `{{language}}`; unknown placeholders are validation errors. No conditionals, loops, includes, JavaScript or HTML templates.
- Explicit per-operation model selection wins. Fallback is visible and recorded.
- Fallback allowed only for network, timeout, rate-limit and recoverable 5xx. Never for auth, invalid model, context/input validation, unsafe content or cancellation.
- Embedding tasks never fall back across profiles; they require Space repair/migration.
- No packaging in this plan.

## Task 1: Add Notes, Transformation, Insight and Route Attempt Schema

**Files:**
- Create: `src/main/db/migrations/010_notes_insights_routing.sql`
- Create: `src/shared/notes.ts`
- Create: `src/shared/transformations.ts`
- Modify: `src/shared/models.ts`
- Modify: `src/main/db/database.test.ts`

**Tables:** `notes`, `note_links`, `transformations`, `insights`, `model_route_attempts`; links target source/message/citation through typed nullable foreign IDs with one-target check.

- [x] Write failing migration tests for project ownership, Markdown length, archive/delete state, rule version, unique idempotency key, route attempt order and actual provider/model fields.
- [x] Define Zod DTOs and command schemas with explicit maximums: title 200 chars, note body 2 MiB, rule name 100, prompt 20 KiB.
- [x] Run migration tests and typecheck; review and commit `feat: add notes insights and routing schema`.

Evidence (2026-08-28): RED failed with `no such table: notes`; post-review fixes added failing boundary tests for placeholders, route ordering, ownership and schema limits. GREEN: database + strict schemas 33/33, full suite 744/744, typecheck passed; independent fix re-review PASS.

## Task 2: Implement Note CRUD and Links

**Files:**
- Create: `src/main/notes/note-repository.ts`
- Create: `src/main/notes/note-repository.test.ts`
- Create: `src/main/notes/note-service.ts`
- Create: `src/main/notes/note-service.test.ts`

- [x] Write failing tests for create/edit/list/archive/restore/delete, optimistic version conflict, project isolation and valid/invalid links to sources, messages and citations.
- [x] Implement repository transactions and service validation; normalize line endings but preserve Markdown content.
- [x] Deleting/archiving a linked source does not delete the note; link DTO reports target unavailable.
- [x] Run focused tests; review and commit `feat: add persistent linked notes`.

Evidence (2026-08-28): RED began with missing repository/service modules; review fixes added failing tests for state CAS, strict list commands, link error classes, deleted-note isolation and repeated transitions. GREEN: note + strict schema tests 16/16, full suite 752/752, typecheck passed; independent fix re-review PASS.

## Task 3: Implement Model Route Resolution

**Files:**
- Create: `src/main/models/route-repository.ts`
- Create: `src/main/models/route-repository.test.ts`
- Create: `src/main/models/model-router.ts`
- Create: `src/main/models/model-router.test.ts`
- Modify: `src/main/settings/settings-repository.ts`

**Task kinds:** `chat`, `note-title`, `summary`, `key-points`, `qa`, `custom-transformation`, `embedding`.

- [x] Write failing tests for explicit override, task route order, inactive/missing profile skip, capability mismatch, no route, duplicate profile rejection and embedding single-profile resolution.
- [x] Implement deterministic resolution returning profile snapshots, not mutable repository references.
- [x] Settings save validates that every generation task has at least one generation-capable route when configured; embedding route has exactly one embedding profile.
- [x] Run focused tests; review and commit `feat: resolve per task model routes`.

Evidence (2026-08-28): RED failed on missing route repository/router modules; review regression tests then proved legacy/invalid embedding candidates must not fall back. GREEN: router/repository/settings 22/22, full suite 761/761, typecheck passed; independent fix re-review PASS.

## Task 4: Implement Transparent Generation Fallback

**Files:**
- Create: `src/main/models/routed-generation.ts`
- Create: `src/main/models/routed-generation.test.ts`
- Modify: `src/main/chat/chat-service.ts`
- Modify: `src/main/chat/chat-service.test.ts`

**Interfaces:** `generateRouted(taskKind, request, overrideProfileId?, signal)` yields `attempt-started`, `fallback`, normal generation events and final actual profile metadata.

- [x] Write failing tests for allowed timeout/network/429/5xx fallback; forbidden auth/404/context/validation/cancel fallback; all profiles exhausted; explicit override followed by configured fallbacks; attempt persistence.
- [x] Emit a localized-safe fallback DTO containing attempted provider/model, next provider/model and error code without response body/secret.
- [x] Persist each attempt start/end/error/latency and the actual completing profile. Integrate chat without changing citation or cancellation behavior.
- [x] Embedding service must assert it never calls this wrapper.
- [x] Run router/chat focused tests; review and commit `feat: add visible safe model fallback`.

Evidence (2026-08-28): RED covered fallback eligibility/terminal boundaries and caught the real per-attempt model forwarding defect. GREEN: router/chat focused 65/65, full suite 788/788, typecheck and build passed; independent fix-round-5 re-review PASS.

## Task 5: Implement AI Note Titles

**Files:**
- Create: `src/main/notes/title-service.ts`
- Create: `src/main/notes/title-service.test.ts`
- Modify: `src/main/notes/note-service.ts`

- [x] Write failing tests for bilingual prompt, input truncation, explicit profile override, routed fallback, whitespace/quotes cleanup, 80-character cap, empty output and failure preserving original title/body.
- [x] Generate a title from a read snapshot, then update only if note version still matches; return conflict rather than overwrite a concurrent edit.
- [x] Store actual provider/model metadata in route attempts, not note body.
- [x] Run focused tests; review and commit `feat: generate safe note titles`.

Evidence (2026-08-28): RED covered missing title service, real SQLite concurrent-update preservation and deleted-note preflight. GREEN: title/note focused 11/11, full suite 797/797, typecheck passed; independent fix re-review PASS with no findings.

## Task 6: Implement Built-In and Custom Transformation Rules

**Files:**
- Create: `src/main/notes/transformation-repository.ts`
- Create: `src/main/notes/transformation-repository.test.ts`
- Create: `src/main/notes/template-renderer.ts`
- Create: `src/main/notes/template-renderer.test.ts`
- Create: `src/main/notes/builtin-transformations.ts`
- Create: `src/main/notes/builtin-transformations.test.ts`

- [x] Write failing CRUD/version/enabled-state tests and exact built-in snapshot tests for zh-CN/en summary, key points and Q&A prompts.
- [x] Write renderer tests for the four allowed placeholders, missing values, unknown/malformed placeholders and untrusted content containing template syntax.
- [x] Store user rules as plain prompt strings and increment `version` on every semantic edit. Built-ins are code-owned immutable descriptors.
- [x] Run focused tests; review and commit `feat: add safe transformation rules`.

Evidence (2026-08-28): RED failed on the three missing rule/repository/renderer modules. GREEN: Task 6 plus strict-schema focused 21/21, full suite 809/809, typecheck passed; independent review PASS with no Critical/Important findings.

## Task 7: Execute Transformations as Durable Idempotent Tasks

**Files:**
- Create: `src/main/notes/transformation-service.ts`
- Create: `src/main/notes/transformation-service.test.ts`
- Create: `src/main/db/migrations/011_transformation_tasks.sql`
- Modify: `src/main/db/database.test.ts`
- Modify: `src/main/tasks/task-service.ts`
- Modify: `src/main/tasks/task-service.test.ts`
- Modify: `src/main/tasks/task-repository.ts`
- Modify: `src/main/tasks/task-repository.test.ts`
- Modify: `src/shared/tasks.ts`
- Modify: `src/workers/ingestion/chunker.ts`

**Inputs:** one source revision, selected source revisions, message, conversation answer or note. **Idempotency:** SHA-256 of target snapshot hashes + rule ID/version + rendered prompt version + selected route snapshot.

- [x] Write failing tests for every input kind, budget truncation, idempotent reuse, force rerun, cancel, retry, routed fallback, crash recovery and insight-to-note conversion.
- [x] Snapshot authoritative input before model call. Run tasks through stages `preparing -> generating -> saving -> completed`.
- [x] Sanitize/validate output as Markdown text and persist insight with actual provider/model, usage and idempotency key.
- [x] Reusing an identical completed insight returns it immediately; failed/cancelled attempts do not block retry.
- [x] Run focused integration tests; review and commit `feat: run durable research transformations`.

Evidence (2026-08-28): RED failed on the missing transformation service and unrepresentable task kind/stages. GREEN: Task 7, migration, routing and chunking focused 130/130, full suite 832/832, typecheck and build passed; independent fix-round-4 re-review PASS with no Critical/Important findings.

## Task 8: Expose Notes, Transformations and Routes API

**Files:**
- Create: `src/main/ipc/register-note-handlers.ts`
- Create: `src/main/ipc/register-note-handlers.test.ts`
- Create: `src/main/ipc/register-transformation-handlers.ts`
- Create: `src/main/ipc/register-transformation-handlers.test.ts`
- Modify: `src/main/ipc/register-model-handlers.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/create-desktop-api.ts`
- Modify: `src/preload/create-desktop-api.test.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/main/index.ts`

**Desktop API additions:** note CRUD/link/title; rule CRUD/list built-ins; transform run/cancel/retry/list insights/convert; route get/save; route attempt history.

- [ ] Write failing handler/preload tests for every command/result/event, ownership, stale versions, explicit profile override and event cleanup.
- [ ] Implement narrow schemas; renderer cannot supply task state, idempotency keys, provider secrets or raw SQL.
- [ ] Run focused tests, full unit suite, typecheck and build; run Gate E from the master plan.
- [ ] Review and commit `feat: expose research notes and transformations`.

## Completion Gate

This plan is complete when note CRUD/linking and AI title work, all built-in/custom transformations create durable insights, repeated identical runs are idempotent, route settings select the correct profiles, only approved transient failures trigger a visible fallback, all actual model usage is persisted, and no installer has been generated. Final notes/transformation/route visuals remain gated in Plan 6.
