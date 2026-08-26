# MyNotebookLM Vector and Hybrid Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Apply test-driven-development and independent review per task.

**Goal:** Provide a production-grade embedded vector database, local/cloud embeddings, isolated Embedding Spaces, ANN+BM25 retrieval, RRF fusion, health checks and lossless migration/rebuild.

**Architecture:** SQLite owns chunks, Space metadata and activation state. One embedded LanceDB database beneath userData stores a table per Embedding Space. Main-process embedding adapters batch inputs; built-in Transformers.js inference runs outside the renderer. Space builds are shadow writes: verify counts/search, then atomically activate in SQLite; failure leaves the old Space active.

**Tech Stack:** Existing stack plus `@lancedb/lancedb` 0.37.1 and `@huggingface/transformers` 4.2.0.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- Never mix vectors from different provider/model/version/dimension/preprocess/chunking combinations.
- Embedding batches never fail over across models. A failure pauses the task and points to the current Space repair/migration action.
- SQLite text and locators must be sufficient to rebuild LanceDB from zero.
- Lance table names are generated from validated Space UUIDs; never interpolate renderer strings into queries/filters.
- The default built-in model downloads on demand to `userData/models/huggingface`, verifies an allowlisted manifest/hash and reports progress; no code or model is loaded from an arbitrary user URL.
- No packaging in this plan.

## Task 1: Add Vector Dependencies and Embedding Space Schema

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/db/migrations/004_embedding_spaces.sql`
- Create: `src/shared/vector.ts`
- Modify: `src/main/db/database.test.ts`

**Tables:** `embedding_spaces`, `project_embedding_spaces`, `model_artifacts`; states `preparing|building|validating|active|failed|retired`.

- [x] Write failing migration tests for one active Space/project, immutable fingerprint fields, dimension > 0, build progress, old-active preservation and artifact download states.
- [x] Pin both dependencies and install; verify LanceDB native Windows x64 binary resolves under Electron's Node ABI.
- [x] Define `EmbeddingSpaceDto`, `EmbeddingFingerprint`, `VectorHealthDto`, `SearchHitDto` Zod schemas.
- [x] Run migration tests and typecheck; review and commit `feat: add embedding space persistence`.

## Task 2: Implement Cloud and Ollama Embedding Adapters

**Files:**
- Create: `src/main/vector/embedding-provider.ts`
- Create: `src/main/vector/embedding-provider.test.ts`
- Modify: `src/main/models/openai-provider.ts`
- Modify: `src/main/models/gemini-provider.ts`
- Modify: `src/main/models/ollama-provider.ts`

**Interfaces:** `EmbeddingProvider.embedBatch(texts, signal)`, `describe(): EmbeddingFingerprint`; default batch sizes OpenAI-compatible 64, Gemini 32, Ollama 32, overridable downward by provider limits.

- [x] Write failing tests for stable order, empty input rejection, batch splitting, dimension consistency, finite/normalized vector validation, cancellation and provider-specific response shapes.
- [x] Wrap the Plan 1 adapters without duplicating authentication or HTTP code. Capture actual dimension on the first successful probe and freeze it in the Space fingerprint.
- [x] Do not show a special cloud-data warning beyond ordinary provider configuration, matching the user's decision.
- [x] Run focused tests; review and commit `feat: provide cloud embedding batches`.

## Task 3: Implement Managed Built-In Local Embedding

**Files:**
- Create: `src/main/vector/local-model-manager.ts`
- Create: `src/main/vector/local-model-manager.test.ts`
- Create: `src/main/vector/local-embedding-provider.ts`
- Create: `src/main/vector/local-embedding-provider.test.ts`
- Create: `src/main/vector/local-model-manifest.ts`

**Model:** `Xenova/multilingual-e5-small`, revision pinned to a tested commit, 384 dimensions, mean pooling, normalized output, query prefix `query: ` and document prefix `passage: `.

- [x] Before implementation, resolve the exact Hugging Face revision and required ONNX/tokenizer file SHA-256 values; store the fixed allowlist in `local-model-manifest.ts` and cover it with a snapshot test.
- [x] Write failing tests with a fake downloader/runtime for resume, hash mismatch deletion, atomic artifact activation, offline missing-model error, progress, single-flight model load and cancellation between batches.
- [x] Configure Transformers.js cache/local paths under userData and disable arbitrary remote model names. Load one singleton pipeline in main/utility execution, never renderer.
- [x] Write deterministic semantic smoke assertions using a tiny checked-in fixture or mocked runtime; do not download the real model in ordinary unit tests.
- [x] Run focused tests; review and commit `feat: add managed local embeddings`.

## Task 4: Implement LanceDB Space Tables and Indexes

**Files:**
- Create: `src/main/vector/lance-store.ts`
- Create: `src/main/vector/lance-store.test.ts`
- Create: `src/main/platform/paths.ts` modifications

**Table columns:** `chunk_id`, `project_id`, `source_id`, `revision_id`, `space_id`, `ordinal`, `content_hash`, `text`, `vector: FixedSizeList<Float32>`, `locator_json`, `created_at`.

- [x] Write real temporary-directory integration tests for create/open, add/upsert by `chunk_id`, delete revision/project/Space, count, vector search, full-text BM25 search and metadata filtering.
- [x] Create an FTS index on `text`, scalar indexes on project/source/revision/space IDs and an ANN index after enough rows; small tables must still work by exhaustive vector search.
- [x] Validate all write rows against the Space dimension before LanceDB receives them. Serialize locators canonically.
- [x] Add a single-process write mutex per Space and close connections during shutdown.
- [x] Run focused tests twice against clean temporary stores; review and commit `feat: add embedded lancedb store`.

## Task 5: Complete Ingestion with Embedding and Verified Indexing

**Files:**
- Create: `src/main/vector/indexing-service.ts`
- Create: `src/main/vector/indexing-service.test.ts`
- Modify: `src/main/sources/ingestion-service.ts`
- Modify: `src/main/tasks/task-service.ts`

**Pipeline stages:** `validating -> copying/fetching -> parsing -> chunking -> downloading_model? -> embedding -> indexing -> validating_index -> completed`.

- [x] Write failing integration tests for batches, progress weighting, cancellation, retry resume by content hash, provider failure, Lance write failure, count mismatch and atomic revision activation.
- [x] Embed chunks from SQLite, write Lance rows, verify row count/content hashes and execute one probe query. Only then set the source revision active and task completed in one SQLite transaction.
- [x] On failure, retain managed original, chunks and task evidence; delete incomplete Lance rows by revision before retry.
- [x] Resume Plan 2 `awaiting_embedding` tasks on startup.
- [x] Run ingestion/vector integration tests; review and commit `feat: finish verified source indexing`.

## Task 6: Implement Space Lifecycle, Migration and Rebuild

**Files:**
- Create: `src/main/vector/space-repository.ts`
- Create: `src/main/vector/space-repository.test.ts`
- Create: `src/main/vector/space-service.ts`
- Create: `src/main/vector/space-service.test.ts`
- Create: `src/main/vector/vector-backup.ts`

**Operations:** inspect, create/build, activate, retry, cancel, optimize, rebuild current, migrate to new fingerprint, retire.

- [x] Write failing tests for fingerprint reuse, shadow build, successful atomic activation, failed validation rollback, cancel rollback, crash recovery, old-Space retention and deletion only after confirmed new activation.
- [x] Before schema migrations/Space activation, use SQLite Backup API and keep exactly the newest three verified backups.
- [x] A full rebuild reads current SQLite chunks and managed originals only when chunks are missing; it never trusts old Lance rows.
- [x] Optimization is an explicit task and must not block reads longer than the underlying table commit.
- [x] Run Space lifecycle tests including simulated process restart at every state boundary; review and commit `feat: manage embedding space lifecycle`.

## Task 7: Implement ANN + BM25 + RRF Retrieval

**Files:**
- Create: `src/main/retrieval/rrf.ts`
- Create: `src/main/retrieval/rrf.test.ts`
- Create: `src/main/retrieval/retrieval-service.ts`
- Create: `src/main/retrieval/retrieval-service.test.ts`

**Defaults:** retrieve ANN 40 and BM25 40, `RRF(k=60)`, dedupe content hash within source revision, diversify to max 4 adjacent chunks/source before final top 12.

- [x] Write failing pure RRF tests for missing ranks, deterministic ties, duplicate hashes and source diversity.
- [x] Write integration tests proving only selected project/current revision/current active Space survive; deleted/archived source records are excluded after SQLite revalidation.
- [x] Embed the query with query preprocessing, run vector and FTS in parallel, fuse, then hydrate authoritative text/locator from SQLite.
- [x] Return a typed `INDEX_UNAVAILABLE` repair action for missing/unhealthy Space rather than empty success.
- [x] Run focused retrieval tests; review and commit `feat: add hybrid retrieval with rrf`.

## Task 8: Expose Vector Health and Retrieval APIs

**Files:**
- Create: `src/main/ipc/register-vector-handlers.ts`
- Create: `src/main/ipc/register-vector-handlers.test.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/create-desktop-api.ts`
- Modify: `src/preload/create-desktop-api.test.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/main/index.ts`

**Desktop API additions:** `vector.getHealth`, `vector.startMigration`, `vector.rebuild`, `vector.optimize`, `vector.cancelTask`, `retrieval.search`, plus validated task progress subscription.

- [x] Write failing IPC tests for project ownership, profile capability, active task conflicts, cancellation and Zod rejection of forged Space IDs/filters.
- [x] Implement narrow handlers; no raw Lance filter/SQL/vector is accepted from renderer.
- [x] Run focused tests, all LanceDB tests, full unit suite, typecheck and build; run Gate C from the master plan.
- [x] Review and commit `feat: expose vector lifecycle api`.

## Completion Gate

This plan is complete when every source can be embedded locally or through each supported embedding provider, LanceDB supports real ANN/FTS/filter operations, Spaces migrate without losing the old active index on failure, the database can be rebuilt from SQLite, hybrid retrieval is deterministic and project-safe, and no installer has been generated. Vector UI waits for Plan 6's approved visual gate.
