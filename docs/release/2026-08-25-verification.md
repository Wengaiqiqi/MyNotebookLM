# Task 9 Verification — Full Functional, Security and Failure Test Matrix

Date: 2026-08-30 · Branch: `codex/rag-pipeline-fixes` · Base: `a56ce88`

## Gates (run from clean output state after `npm ci`, exact exit codes)

| Command | Exit code | Result |
| --- | --- | --- |
| `npm test` | 0 | 107 files / 996 tests passed (vitest 4.1.11) |
| `npm run typecheck` | 0 | `tsc -p tsconfig.node.json && tsc -p tsconfig.web.json` |
| `npm run build` | 0 | `electron-vite build` (main 85 modules, preload 92, renderer 171) |
| `npm run test:e2e` | 0 | 20/20 Playwright tests passed (2.1m, 1 worker) |

New Task 9 e2e coverage: `complete-research-flow` (1), `recovery-and-failures` (5), `security-boundaries` (3); existing `desktop.spec.ts` (11) all green.

## Matrix item evidence

1. Provider matrix — `src/test/provider-contract-matrix.test.ts` (4 tests): OpenAI, OpenAI-compatible, Anthropic, Gemini, Ollama — discovery / generation / embedding / streaming / cancel / HTTP-error mapping via local fake provider servers (`startFakeProviderServer`). No real network. Local embedding download/inference: `src/main/vector/local-model-manager.test.ts` (controlled artifact download/verify/staging on a managed root) and `src/main/vector/local-embedding-provider.test.ts` (runtime inference, 384-d vectors, cancellation) — existing infrastructure reused, no real HF calls.
2. Fixture matrix — `src/test/document-fixture-matrix.test.ts` (8 tests): all eight source kinds (text, markdown, pdf, docx, pptx, xlsx, csv, url) with exact paragraph/heading/page/slide/row/section locator assertions through the real chunker.
3. Complete desktop chain — `e2e/complete-research-flow.spec.ts`: onboarding skip → project → seeded text/csv imports → Lance index bootstrap → retrieval → chat with citation open (exact S1/paragraph locator) → note + generated title → built-in summary + custom rule transformation → forced primary-500 fallback (message DTO profile/model + route attempts) → Space migration v2 → active-space rebuild → restart persistence.
4. Failure chain — `e2e/recovery-and-failures.spec.ts` (5 tests): skip onboarding persists, missing model → VALIDATION, offline → NETWORK, save-profile 401 → AUTH, chat 429 → failed message `RATE_LIMITED` (with active-space bootstrap so the provider is reached), malformed SSE → AUTH-at-probe + failed ingest/parser task with error code (real `chooseFiles`→`importFile` path with stubbed native dialog), cancel mid-stream → cancelled/failed terminal state, corrupt Lance manifest → unhealthy + migration rebuild recovery.
5. Security chain — `e2e/security-boundaries.spec.ts` (3 tests): renderer sandbox (`require`/`process` undefined, preload API present), window.open denial (no new window), will-navigate denial (URL unchanged), credential redaction (profile list JSON contains neither secret nor `apiKey`), loopback SSRF import rejection (`UNSAFE_INPUT`). Unit evidence for the rest: traversal/signature/macro `src/main/sources/file-preflight.test.ts`; SSRF redirect re-validation, redirect budget, resolver pinning/DNS-rebinding mitigation `src/main/sources/url-source.test.ts` + address-pinned socket in `src/main/sources/url-source.ts`; Markdown sanitization `src/renderer/src/chat/SafeMarkdown.test.tsx`.

## Final correctness/security review findings

- HIGH — `vector.rebuild` on an ACTIVE space always failed with INTERNAL: `SpaceRepository.setState` precondition excluded `active`, and an active space could not be rebuilt in place. Fixed in `src/main/vector/space-repository.ts` (allow `active`, add `clearSpaceStorage`) and `src/main/vector/space-service.ts` (in-place rebuild clears Lance storage before rebuilding). Regression tests: `space-repository.test.ts`, `space-service.test.ts` (in-place success + failure-preserves-row ordering), `space-lifecycle.integration.test.ts` (real SQLite+Lance corrupt-active rebuild). All verified RED→GREEN.
- MEDIUM (test-infra only, fixed in spec) — rate-limit and cancel e2e sub-cases initially could not reach the provider because the project had no active vector space (`INDEX_UNAVAILABLE` masked the intended provider failure). Fixed by bootstrapping an active space + Lance table in those tests; product behavior unchanged.

No remaining high/medium findings.