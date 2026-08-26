# MyNotebookLM RAG Chat and Citations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Apply test-driven-development and independent review per task.

**Goal:** Deliver persistent multi-turn research conversations with hybrid retrieval, streaming answers, stop/regenerate and trustworthy source citations.

**Architecture:** Chat service persists the user message, retrieves authoritative chunks, constructs a bounded prompt with opaque citation IDs, invokes the configured generation adapter and streams validated events through preload. The assistant draft is checkpointed and finalized transactionally with citation records. Renderer sanitizes Markdown and uses structured citation metadata rather than model-supplied links.

**Tech Stack:** Existing stack plus Marked 18.0.11 and DOMPurify 3.4.14.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- A model can cite only context IDs issued by the retrieval service for that request.
- Citation destination comes from SQLite locator metadata, never generated Markdown or a model URL.
- Abort preserves partial assistant text with status `cancelled`; failure preserves a failed draft and repair action; neither masquerades as a complete answer.
- Provider secrets/responses stay in main except normalized text/usage/status events.
- Markdown allows text, headings, lists, tables, blockquotes, code and safe links; strip HTML, scripts, styles, iframes, event attributes, remote images and unsafe protocols.
- No packaging in this plan.

## Task 1: Add Conversation Persistence

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/db/migrations/007_conversations.sql`
- Create: `src/shared/chat.ts`
- Create: `src/main/chat/conversation-repository.ts`
- Create: `src/main/chat/conversation-repository.test.ts`
- Modify: `src/main/db/database.test.ts`

**Tables:** `conversations`, `messages`, `message_citations`; message states `streaming|completed|cancelled|failed`.

- [x] Write failing migration/repository tests for project ownership, ordered messages, one assistant reply lineage, regeneration supersession, citation uniqueness and cascade/soft-delete behavior.
- [x] Pin Marked and DOMPurify. Define Zod DTOs for conversations, messages, citation labels/locators and stream events.
- [x] Implement repository transactions; store provider/profile/model, usage, error code, completion reason and timestamps.
- [x] Run focused tests and typecheck; review and commit `feat: add conversation persistence`.

## Task 2: Build Citation-Aware Context Assembly

**Files:**
- Create: `src/main/chat/context-builder.ts`
- Create: `src/main/chat/context-builder.test.ts`
- Create: `src/main/chat/prompts.ts`
- Create: `src/main/chat/prompts.test.ts`

**Context format:** stable IDs `S1..S12`, each block contains source display name, locator summary and delimited authoritative text. User/source text is data, never system instructions.

- [x] Write failing tests for deterministic citation IDs, bilingual prompts, prompt-injection text escaping, maximum budget, oversized chunk truncation, empty retrieval and previous-turn trimming.
- [x] Budget with provider profile context size when known; otherwise use configured default 16,000 estimated tokens. Reserve 20% for output, at least 1,024 output tokens and 10% overhead.
- [x] Include recent conversation turns newest-first until budget, then restore chronological order. Never truncate system safety/citation instructions.
- [x] Prompt requires grounded answer, explicit `[S#]` markers for factual claims and an honest no-evidence response when context is insufficient.
- [x] Run focused tests; review and commit `feat: assemble bounded cited rag context`.

## Task 3: Parse and Validate Model Citations

**Files:**
- Create: `src/main/chat/citation-parser.ts`
- Create: `src/main/chat/citation-parser.test.ts`

- [x] Write failing tests for single/multiple citations, repeated markers, unknown IDs, markers split across stream chunks, code blocks, malformed markers and exact character ranges.
- [x] Implement incremental text buffering for display and a final parser that recognizes `[S1]` through `[S12]` outside fenced/inline code.
- [x] Remove unknown markers from structured citation records but leave original answer text visible; flag `hasInvalidCitations` for diagnostics without inventing sources.
- [x] Resolve recognized IDs only against the request's retrieval map and persist normalized citation rows.
- [x] Run focused tests; review and commit `feat: validate generated citation markers`.

## Task 4: Implement Streaming Chat Orchestration

**Files:**
- Create: `src/main/chat/chat-service.ts`
- Create: `src/main/chat/chat-service.test.ts`
- Create: `src/main/chat/chat-session-registry.ts`
- Create: `src/main/chat/chat-session-registry.test.ts`

**Flow:** validate project/conversation -> persist user -> retrieve -> persist streaming assistant -> generate -> checkpoint -> finalize citations/usage.

- [x] Write failing tests for normal stream, no results, missing generation profile, provider failure, user abort, concurrent send conflict, renderer disconnect, checkpoint recovery and actual provider/model persistence.
- [x] Keep active `AbortController`s in a main-only registry keyed by opaque request ID; reject cross-project/user cancellation.
- [x] Checkpoint assistant text at most every 1 second or 2 KiB, whichever comes first; always final-checkpoint on abort/error.
- [x] On startup, convert abandoned `streaming` messages to `cancelled` with interruption metadata.
- [x] Use the current default generation profile directly. Plan 5 inserts routing around this provider selection without changing stream/citation semantics.
- [x] Run focused tests with deterministic retrieval and fake streaming provider; review and commit `feat: stream persistent rag conversations`.

## Task 5: Add Conversation Operations and Citation Opening

**Files:**
- Create: `src/main/chat/citation-opener.ts`
- Create: `src/main/chat/citation-opener.test.ts`
- Modify: `src/main/chat/chat-service.ts`
- Modify: `src/main/chat/chat-service.test.ts`

**Operations:** list/create/rename/archive/delete conversation, send/stop/regenerate/copy-ready DTO, open citation.

- [ ] Write failing tests for regenerate lineage, no duplicate user message, archived conversation behavior, source deleted after answer and locator opening by source type.
- [ ] For local sources open the managed original using Electron shell only after repository lookup. PDF/page, PPTX/slide and Office cell locators are shown in an in-app citation detail panel; use OS opening as the document launch, without claiming Office deep-link support that Windows cannot guarantee.
- [ ] For URL citations open only the authoritative stored final HTTP/HTTPS URL after revalidation; reject model text as a destination.
- [ ] Run focused tests; review and commit `feat: manage conversations and open citations`.

## Task 6: Expose Versioned Streaming IPC

**Files:**
- Create: `src/main/ipc/register-chat-handlers.ts`
- Create: `src/main/ipc/register-chat-handlers.test.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/create-desktop-api.ts`
- Modify: `src/preload/create-desktop-api.test.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/main/index.ts`

**Desktop API additions:** conversation CRUD/list messages, `chat.send`, `chat.stop`, `chat.regenerate`, `citations.open`; subscribe by opaque request ID to `started|retrieval|text-delta|usage|fallback|completed|cancelled|failed`.

- [ ] Write failing tests for schema validation on every event, subscribing before send, event/request/project isolation, unsubscription and destroyed window cleanup.
- [ ] Register subscriptions before provider work begins so the first event cannot race the renderer.
- [ ] Backpressure/coalesce text deltas to no more than 30 renderer events/second while retaining byte-exact final text.
- [ ] Run IPC/preload tests and typecheck; review and commit `feat: expose secure chat streams`.

## Task 7: Add Safe Markdown and Chat State Components

**Files:**
- Create: `src/renderer/src/chat/SafeMarkdown.tsx`
- Create: `src/renderer/src/chat/SafeMarkdown.test.tsx`
- Create: `src/renderer/src/chat/useChatStream.ts`
- Create: `src/renderer/src/chat/useChatStream.test.ts`

- [ ] Write failing tests proving scripts, raw HTML, javascript/data links, remote images and inline handlers are stripped; code/lists/tables and safe HTTP links remain.
- [ ] Configure Marked with raw HTML disabled/escaped and DOMPurify with an explicit tag/attribute allowlist; render citations as buttons only when matching structured citation DTOs.
- [ ] Write hook tests for send, live deltas, stop, failure repair, restart hydration, regenerate and subscription cleanup.
- [ ] Implement functional state components without final styling. Plan 6 applies the user-approved visual.
- [ ] Run focused component tests; review and commit `feat: add safe streaming chat components`.

## Task 8: Complete RAG Integration Evidence

**Files:**
- Create: `src/main/chat/rag-integration.test.ts`
- Modify: `e2e/desktop.spec.ts`

- [ ] Add an integration test: indexed fixtures -> deterministic query embedding -> ANN/BM25/RRF -> prompt -> fake provider streaming citations -> persisted completed message -> citation open lookup.
- [ ] Add cancellation, no-evidence, invalid citation and regenerate variants.
- [ ] Add an Electron E2E through the preload bridge using fake providers; do not freeze final chat styling before Plan 6 approval.
- [ ] Run all chat/retrieval tests, full suite, typecheck and build; run Gate D from the master plan.
- [ ] Review and commit `test: verify end to end cited rag`.

## Completion Gate

This plan is complete when conversations and messages persist across restart, retrieved evidence is budgeted and injection-safe, streaming can be stopped/regenerated, citations resolve only to authoritative source rows, Markdown is sanitized, the full fake-provider desktop RAG path passes, and no installer has been generated. Final chat visuals remain gated in Plan 6.
