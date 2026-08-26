# MyNotebookLM Ingestion and Durable Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Use test-driven-development and independent review for each task.

**Goal:** Import every approved modern source type through a durable, cancellable pipeline that preserves citation locators and survives application restarts.

**Architecture:** Main validates inputs, copies local files to managed storage, records sources/revisions/tasks in SQLite and dispatches serializable work to worker threads. Format adapters emit one normalized block stream. SQLite stores every rebuildable chunk and locator; vector work remains queued for Plan 3.

**Tech Stack:** Existing stack plus pdfjs-dist 6.2.108, JSZip 3.10.1, fast-xml-parser 5.11.0, ExcelJS 4.4.0, csv-parse 7.0.2, Readability 0.6.0 and linkedom 0.18.13.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- Supported: `.txt`, `.md`, `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.csv`, HTTP/HTTPS URL. Reject `.doc`, `.ppt`, `.xls`, macro-enabled/other formats and extension/signature mismatch.
- Never execute macros, formulas, scripts, embedded objects, remote templates or active content.
- Local files are atomically copied into `userData/data/sources/<projectId>/<sourceId>/<revisionId>/original.<ext>` before processing.
- URL fetch denies loopback, private, link-local, multicast, unspecified and metadata-service destinations for IPv4/IPv6; validate every redirect and resolved address.
- Default limits: 100 MiB local file, 20 MiB decompressed URL response, at most 5 redirects, connect/response timeout 30 seconds.
- No packaging in this plan.

## Task 1: Install Pinned Parsers and Add Source Schema

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/db/migrations/003_sources_tasks.sql`
- Create: `src/shared/sources.ts`
- Create: `src/shared/tasks.ts`
- Modify: `src/main/db/database.test.ts`

**Tables:** `sources`, `source_revisions`, `source_chunks`, `tasks`; indexes on project/state, source/current revision, task/state/created and chunk revision/ordinal/hash.

- [x] Write failing migration tests for foreign keys, state checks, one active revision, source soft-delete fields and task progress range.
- [x] Pin the parser dependencies listed above. Run `npm install` with only process-scoped proxy variables if the registry needs proxy `127.0.0.1:7890`.
- [x] Add Zod DTOs for source type/status, normalized locator, task kind/state/stage/progress and safe error summaries.
- [x] Run migration tests and `npm run typecheck`; review and commit `feat: add ingestion schema and parsers`.

## Task 2: Implement Durable Task State Machine

**Files:**
- Create: `src/main/tasks/task-repository.ts`
- Create: `src/main/tasks/task-repository.test.ts`
- Create: `src/main/tasks/task-service.ts`
- Create: `src/main/tasks/task-service.test.ts`
- Create: `src/main/tasks/retry-policy.ts`
- Create: `src/main/tasks/retry-policy.test.ts`

**State transitions:** `queued -> running -> completed|failed|cancelled`; on startup, stale `running` tasks become `queued` with `attempt + 1` if retryable, otherwise `failed` with `INTERRUPTED`.

- [x] Write failing tests for legal/illegal transitions, monotonic progress, cancellation request, retry classification, exponential delays `1s, 2s, 4s, 8s, 16s` plus bounded jitter, five-attempt cap and idempotency keys.
- [x] Implement repository compare-and-swap transitions inside transactions and a service clock/random injection for deterministic tests.
- [x] Authentication, validation, unsafe input, unsupported format and cancellation are never auto-retried.
- [x] Run focused tests and a real temporary SQLite restart test; review and commit `feat: add durable task state machine`.

## Task 3: Secure Local File Preflight and Managed Storage

**Files:**
- Create: `src/main/sources/file-preflight.ts`
- Create: `src/main/sources/file-preflight.test.ts`
- Create: `src/main/sources/managed-files.ts`
- Create: `src/main/sources/managed-files.test.ts`
- Create: `src/main/sources/source-repository.ts`
- Create: `src/main/sources/source-repository.test.ts`
- Add fixtures: `src/test/fixtures/security/*`

**Signature rules:** PDF `%PDF-`; OOXML ZIP containing `[Content_Types].xml` plus required `word/`, `ppt/` or `xl/` parts; UTF-8 text/Markdown/CSV must contain no NUL and decode without replacement; extension must match selected parser.

- [x] Write failing tests for allowed extensions, upper-case names, traversal names, symlinks/reparse points, size limit, mismatched signatures, legacy Office, macro-enabled files and atomic cleanup after copy failure.
- [x] Generate safe unique storage names from IDs, never user basenames. Resolve and verify every destination remains under the exact revision directory before create/move/delete.
- [x] Hash bytes with SHA-256 during copy; fsync temporary file, atomic rename, then create revision/task transactionally.
- [x] Run focused security/storage/repository tests; review and commit `feat: securely stage imported files`.

## Task 4: Secure URL Fetch and Article Extraction

**Files:**
- Create: `src/main/sources/url-policy.ts`
- Create: `src/main/sources/url-policy.test.ts`
- Create: `src/main/sources/url-source.ts`
- Create: `src/main/sources/url-source.test.ts`
- Add fixtures: `src/test/fixtures/url/article.html`

**Interfaces:** `DnsResolver`, `SafeHttpClient`, `FetchedArticle { finalUrl, title, byline?, text, sections, contentHash }`.

- [x] Write failing tests for schemes, userinfo, invalid ports, DNS returning any forbidden address, decimal/hex IP tricks, IPv4-mapped IPv6, redirect to forbidden target, redirect limit, content type, decompressed size and timeout.
- [x] Resolve host before each request, connect only through the validated address while preserving TLS hostname/Host semantics, and revalidate redirects. Do not trust proxy-bypassed DNS implicitly.
- [x] Parse HTML with linkedom and Readability; remove scripts/styles/forms/iframes/remote resources and return section locators with final URL and heading path.
- [x] Run focused tests using only controlled local fake transports/resolvers; review and commit `feat: securely import web articles`.

## Task 5: Define Normalized Document Blocks and Chunker

**Files:**
- Create: `src/workers/ingestion/types.ts`
- Create: `src/workers/ingestion/chunker.ts`
- Create: `src/workers/ingestion/chunker.test.ts`
- Add fixtures: `src/test/fixtures/text/*`

**Interfaces:**

```ts
interface DocumentBlock {
  kind: 'heading' | 'paragraph' | 'table' | 'list' | 'sheet-row';
  text: string;
  locator: SourceLocator;
}
interface PreparedChunk {
  ordinal: number;
  text: string;
  locator: SourceLocator;
  contentHash: string;
  tokenEstimate: number;
}
```

- [x] Write failing bilingual tests for deterministic order, heading context, table boundaries, 900-token target, 150-token overlap, no empty chunk, stable SHA-256 and locator range merging.
- [x] Implement deterministic token estimate (`CJK code points + ceil(non-CJK UTF-8 words * 1.3)`) and sentence/paragraph-aware splits. Record `chunkingVersion = 'blocks-900-150-v1'`.
- [x] Run focused tests twice and assert byte-identical snapshots; review and commit `feat: add deterministic source chunking`.

## Task 6: Implement TXT, Markdown and CSV Parsers

**Files:**
- Create: `src/workers/ingestion/parsers/text-parser.ts`
- Create: `src/workers/ingestion/parsers/text-parser.test.ts`
- Create: `src/workers/ingestion/parsers/markdown-parser.ts`
- Create: `src/workers/ingestion/parsers/markdown-parser.test.ts`
- Create: `src/workers/ingestion/parsers/csv-parser.ts`
- Create: `src/workers/ingestion/parsers/csv-parser.test.ts`
- Add fixtures: `src/test/fixtures/documents/*.{txt,md,csv}`

- [x] Write golden tests for CRLF/LF, BOM, blank paragraphs, Markdown heading ancestry/list/code/table text and CSV quoted cells/newlines/delimiter detection/row ranges.
- [x] Parse UTF-8 only; produce paragraph, heading and row locators. CSV output includes header names and row numbers.
- [x] Run all three parser tests and snapshot normalized blocks; review and commit `feat: parse text markdown and csv sources`.

## Task 7: Implement PDF and DOCX Parsers

**Files:**
- Create: `src/workers/ingestion/parsers/pdf-parser.ts`
- Create: `src/workers/ingestion/parsers/pdf-parser.test.ts`
- Create: `src/workers/ingestion/parsers/docx-parser.ts`
- Create: `src/workers/ingestion/parsers/docx-parser.test.ts`
- Add fixtures: `src/test/fixtures/documents/sample.pdf`
- Add fixtures: `src/test/fixtures/documents/sample.docx`

- [x] Write golden tests for PDF page order/page locators/empty pages and DOCX headings/paragraphs/lists/tables with heading-path and table-cell locators.
- [x] Use PDF.js text content per page; normalize whitespace without merging pages.
- [x] Use JSZip + fast-xml-parser on OOXML relationships, styles and document XML. Ignore macros, external relationships, comments and embedded objects.
- [x] Run parser tests and validate fixture hashes; review and commit `feat: parse pdf and docx sources`.

## Task 8: Implement PPTX and XLSX Parsers

**Files:**
- Create: `src/workers/ingestion/parsers/pptx-parser.ts`
- Create: `src/workers/ingestion/parsers/pptx-parser.test.ts`
- Create: `src/workers/ingestion/parsers/xlsx-parser.ts`
- Create: `src/workers/ingestion/parsers/xlsx-parser.test.ts`
- Add fixtures: `src/test/fixtures/documents/sample.pptx`
- Add fixtures: `src/test/fixtures/documents/sample.xlsx`

- [x] Write golden tests for slide order, titles, speaker notes, text boxes and slide locators; write XLSX tests for visible sheets, cells, formulas using cached values only, dates and exact sheet/cell ranges.
- [x] Parse PPTX OOXML with JSZip + fast-xml-parser; ignore external media/links and active content.
- [x] Parse XLSX in non-calculating mode with ExcelJS; never evaluate a formula. Emit bounded row blocks with sheet and A1 range locators.
- [x] Run parser tests and snapshots; review and commit `feat: parse powerpoint and excel sources`.

## Task 9: Run Parsers in Worker Threads

**Files:**
- Create: `src/workers/ingestion/worker-entry.ts`
- Create: `src/main/tasks/worker-pool.ts`
- Create: `src/main/tasks/worker-pool.test.ts`
- Create: `src/main/sources/ingestion-service.ts`
- Create: `src/main/sources/ingestion-service.test.ts`
- Modify: `electron.vite.config.ts`

**Worker messages:** versioned `start`, `progress`, `result`, `error`, `cancel`; all validated before use. Concurrency defaults to `max(1, min(2, availableParallelism() - 1))`.

- [x] Write failing tests for serializable messages, progress throttled to at most 10 events/second/task, cooperative cancel, hard termination after 5 seconds, worker crash replacement and restart recovery.
- [x] Bundle a worker entry. Worker parses and chunks; main writes chunks/revision state in one transaction only after a successful complete result.
- [x] Leave successful parsing task at stage `awaiting_embedding`, still `running`; Plan 3 completes it after vectors are verified. If no embedding profile is configured, use the built-in local profile and expose its download state in Plan 3.
- [x] Run worker and ingestion integration tests with temporary userData; review and commit `feat: process sources in durable workers`.

## Task 10: Expose Source and Task API

**Files:**
- Create: `src/main/ipc/register-source-handlers.ts`
- Create: `src/main/ipc/register-source-handlers.test.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/create-desktop-api.ts`
- Modify: `src/preload/create-desktop-api.test.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/main/index.ts`

**Desktop API additions:** choose files via main-process dialog, import files/URL, list sources/tasks, cancel/retry/remove source, subscribe to task updates. Renderer may submit only opaque dialog tokens/URLs, never arbitrary filesystem destinations.

- [x] Write failing IPC/preload tests for schemas, dialog cancellation, project ownership checks, invalid retries, event unsubscribe and safe errors.
- [x] Implement handler/service composition and task update fan-out with listener cleanup on destroyed webContents.
- [x] On source removal, mark deleting and schedule managed-file/chunk cleanup; do not perform broad synchronous recursive deletion from renderer input.
- [x] Run focused tests, full unit suite, typecheck and build; run Gate B from the master plan.
- [x] Review and commit `feat: expose complete ingestion api`.

## Completion Gate

This plan is complete when all eight source kinds produce deterministic blocks/chunks and precise locators, unsafe inputs are rejected before durable mutation, tasks cancel/retry/recover correctly, no parser executes active content, all IPC is validated, and no installer has been generated. Source UI intentionally waits for its approved visual gate in Plan 6; this plan supplies functional APIs and automated integration evidence.
