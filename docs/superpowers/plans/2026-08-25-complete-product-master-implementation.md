# MyNotebookLM Complete Product Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this program one task at a time. Every production behavior follows RED -> GREEN -> REFACTOR, and every completed task receives an independent review before the next task begins.

**Goal:** Turn the approved Electron foundation into the complete Windows x64 MyNotebookLM product and deliver exactly one final, tested NSIS `.exe` after every approved capability works.

**Architecture:** Electron main remains the composition root and owns SQLite, DPAPI credentials, provider network calls, managed files, LanceDB, queues and system integration. Worker threads perform document parsing and CPU-heavy preparation. A sandboxed React renderer uses only a runtime-validated preload API. SQLite is business truth; LanceDB is a rebuildable retrieval projection.

**Tech Stack:** Electron 43.4.1, React 19.2.8, TypeScript 7.0.2, better-sqlite3 13.0.3, Zod 4.4.3, LanceDB 0.37.1, Transformers.js 4.2.0, Vitest 4.1.11, Playwright 1.62.1, electron-builder 26.15.3, NSIS.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- Windows x64 desktop only. No browser launch, external web server, Docker, Python runtime or developer runtime is required after installation.
- Preserve `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, navigation denial and a narrow Zod-validated preload bridge.
- Do not put API keys, authorization headers, source bodies or model prompts in renderer state, logs or IPC errors.
- SQLite is authoritative. LanceDB contains only rebuildable chunks, metadata and vectors.
- No permanent disabled or “later” UI. Missing prerequisites produce a visible repair action.
- Explicitly out of scope: podcast, TTS, STT, audio/video processing, `.doc`, `.ppt`, `.xls`, cloud sync, collaboration, accounts and non-Windows platforms.
- Do not implement an unapproved new screen. Generate a high-fidelity image, obtain user approval, then implement and compare a real Electron screenshot.
- Use the already approved `first-launch.png`, `empty-project.png`, `project-list.png`, `create-project.png` and `settings-models.png` without another design gate.
- Do not run `npm run package:win`, create a release tag, publish, push or deliver an installer until Plan 6's final-release task.
- Do not alter or deliver the obsolete installer currently under `dist`.
- Each task: failing focused test, minimal implementation, focused test, full impacted suite, review, commit.

## Program Order

| Order | Plan | Depends on | Completion gate |
|---:|---|---|---|
| 1 | `2026-08-25-model-connectivity-implementation.md` | approved foundation | onboarding, settings, credentials and provider contracts pass |
| 2 | `2026-08-25-ingestion-and-tasks-implementation.md` | Plan 1 shared API conventions | every supported source parses with durable tasks and locators |
| 3 | `2026-08-25-vector-and-retrieval-implementation.md` | Plans 1-2 | local/cloud embeddings, LanceDB, Spaces and hybrid retrieval pass |
| 4 | `2026-08-25-rag-chat-citations-implementation.md` | Plans 1-3 | streaming RAG, citations and conversations pass |
| 5 | `2026-08-25-notes-transformations-routing-implementation.md` | Plans 1-4 | notes, insights, transformations and safe routing pass |
| 6 | `2026-08-25-complete-ui-and-final-release-implementation.md` | Plans 1-5 | approved UI, complete E2E and exact-hash installer smoke pass |

Plans execute strictly in this order. Tasks inside one plan execute in listed order unless the plan explicitly marks a visual approval pause. No downstream plan may invent or silently change an upstream interface; update both plans and add a contract test when a change is necessary.

## Shared Contract Freeze

All feature plans consume these shared types. Plan 1 creates the model types; Plan 2 creates task/source types; Plan 3 creates retrieval types. Later plans may add fields only through a new schema version.

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppErrorDto };

type AppErrorCode =
  | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'CANCELLED'
  | 'AUTH' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK'
  | 'PROVIDER' | 'UNSUPPORTED_FORMAT' | 'UNSAFE_INPUT'
  | 'INDEX_UNAVAILABLE' | 'INTERNAL';

interface AppErrorDto {
  code: AppErrorCode;
  messageKey: string;
  recoverable: boolean;
  retryAfterMs?: number;
  details?: Record<string, string | number | boolean>;
}
```

No `Error`, raw response, stack, filesystem root, secret or arbitrary provider payload crosses preload.

## Cross-Plan Quality Gates

- [ ] **Gate A — after Plan 1:** run `npm test -- --run src/main/models src/main/settings src/main/credentials src/preload src/renderer`, `npm run typecheck`, `npm run build`, and approved onboarding/settings Electron E2E.
- [ ] **Gate B — after Plan 2:** run all parser fixtures, task crash/recovery/cancel tests, URL security tests, full unit suite, typecheck and build.
- [ ] **Gate C — after Plan 3:** run real temporary LanceDB integration tests, local fake embedding contracts, Space migration/rollback/rebuild tests, full unit suite, typecheck and build.
- [ ] **Gate D — after Plan 4:** run streaming/cancel/citation persistence tests and an Electron RAG flow using fake providers and deterministic embeddings.
- [ ] **Gate E — after Plan 5:** run notes/transformation/idempotency/routing/fallback tests and complete product unit suite.
- [ ] **Gate F — before packaging:** every new visual has written approval and a recorded Electron screenshot in both languages and themes where state differs.
- [ ] **Gate G — final release:** Plan 6's complete checks pass before `package:win`; the generated installer is then installed and tested without rebuilding; its SHA-256 remains identical to the delivered file.

## Required Evidence Ledger

Plan 6 creates `docs/release/2026-08-25-verification.md` and records:

1. Git commit and clean/dirty status.
2. Node/npm/Electron versions used for build.
3. Exact commands, exit codes and test counts.
4. Approved design path and matching runtime screenshot path for each visual state.
5. Fixture matrix for TXT, MD, URL, PDF, DOCX, PPTX, XLSX and CSV.
6. Provider matrix for discovery, generation, embedding, streaming, cancel and classified failures.
7. LanceDB health, rebuild and Embedding Space migration evidence.
8. Fresh-install, upgrade-install, restart persistence and uninstall results.
9. Installer filename, byte size and SHA-256 before and after smoke testing.
10. Honest status of Windows code signing and independent clean-machine availability.

## Final Completion Rule

The program is complete only when every checkbox in all six subplans and every gate above is checked, no visible action is a placeholder, all approved formats/providers/features have automated evidence, and the exact installer that passed smoke testing is the one handed to the user. A successful build by itself is not completion.
