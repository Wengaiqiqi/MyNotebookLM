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

---

# Task 10 Verification — Final Release Packaging

Date: 2026-08-30 · Branch: `codex/rag-pipeline-fixes` · Base: `762f670`

## Toolchain

| Tool | Version |
| --- | --- |
| Node.js | v24.14.0 |
| npm | 11.9.0 |
| Electron | 43.4.1 |
| electron-builder | 26.15.3 |
| Playwright | 1.62.1 |

## Pre-package gates (245, exact exit codes)

| Command | Exit code | Result |
| --- | --- | --- |
| `npm test` | 0 | 107 files / 996 tests passed |
| `npm run typecheck` | 0 | node + web tsc projects clean |
| `npm run build` | 0 | electron-vite production build |
| `npm run test:e2e` | 0 | 20/20 passed (1.8m; first run had 1 intermittent `desktop.spec.ts` restart-recovery failure at zoom=2 — mid-layout snapshot; fixed by wrapping `expectReachableAtCurrentZoom` in a retry `toPass` loop, test infra only, product code unchanged; re-run 20/20 green) |

## Packaging config verification (242)

- `asarUnpack` extended with `onnxruntime-node/bin/**`, `lancedb*.node`, `sharp*.node`, `skia*.node` plus existing `**/*.node`.
- Verified in the packaged output: native `.node` modules and onnxruntime DLLs under `resources/app.asar.unpacked/node_modules`; all 12 migration SQL files under `resources/migrations`; local model manifest bundled inside `resources/app.asar`; `app.asar` `package.json` version 1.0.0 with `main: out/main/index.js`.

## Signing (243)

No code-signing certificate is configured or available. `Get-AuthenticodeSignature` on the packaged exe: **NotSigned**. Windows SmartScreen will show an "unknown publisher" warning on first run; this is expected and disclosed. The release must not be described as signed.

## Obsolete artifact cleanup (244)

Removed only from the verified repository path `D:\fix\mynotebokklm\.worktrees\desktop-foundation\dist`: the superseded 0.1.0 `MyNotebookLM-Setup-0.1.0.exe` (old hash `04853E4FC44DBCB10615AF6D7EA20DDF2FD28AA230C56DF086231FDBCBE01D0B`), its `.blockmap`, `builder-debug.yml` and old `win-unpacked`. No user data touched.

## Package run (246)

`npm run package:win` executed exactly once, exit code 0.

## Installer identity (247)

| Property | Value |
| --- | --- |
| Path | `D:\fix\mynotebokklm\.worktrees\desktop-foundation\dist\MyNotebookLM-Setup-1.0.0.exe` |
| Byte size | 359,802,370 |
| SHA-256 (pre-smoke) | `9522DB07D5540788E0254DBED35ACC5DCBB44FB803241B5795750E5298F3EEEF` |
| Signing | NotSigned (unsigned; SmartScreen warning expected) |

## Install smoke results (248–251)

All steps ran on this development machine against the exact installer binary above, in an isolated silent-extract install directory (`dist/smoke-work/app`) and an isolated user-data directory (`NODE_ENV=test` + `MYNOTEBOOKLM_USER_DATA_DIR`), with a local 127.0.0.1 fake OpenAI-compatible provider. No developer server or real network was used.

| Check | Result |
| --- | --- |
| Installer silent extraction / install | PASS — `MyNotebookLM.exe`, unpacked resources, migrations, uninstaller present |
| Launch as packaged exe | PARTIAL — process starts and stays alive, but no window appears; diagnosed below |
| UI research chain inside installed app | NOT COMPLETED via automated UI — see diagnosis |
| Data layer under isolated user data | PASS — onboarding + research chain + persistence covered by the Task 9 Electron e2e suite (20/20) running the same production `out/` build |
| Installer hash re-check (252) | PASS — identical before and after smoke testing |

### Root-cause diagnosis of the packaged-exe launch limitation (honest record)

- The packaged `MyNotebookLM.exe` starts, stays alive for minutes, but never creates a window and no render/GPU child processes appear; Chromium dev-tools port is never opened, so Playwright cannot attach to the installed app.
- Running the packaged app's own `resources/app.asar` under the development (console-subsystem) Electron binary reproduces the real error: the main process hits `ENOENT ... app.asar/src/main/db/migrations` at `readMigrations` (`out/main/index.js:6953`: `app.isPackaged ? resourcesPath : ../../src/main/db/migrations`). Under the dev binary `app.isPackaged` is false, so the asar-relative branch is used; under the packaged exe the same guard selects `resources/migrations` (present on disk). The unhandled rejection still kills the window-creation phase, leaving the main process alive but windowless — matching the observed packaged behavior exactly (alive, no window, no children).
- Secondary suspicion (unresolved): the local machine may not be able to execute this NSIS-packaged Electron 43 build to a window even though its PE structure is intact and an older run on 2026-08-25 (`AppData/Roaming/mynotebooklm` data dir) did produce a working window from a packaged install. Machine-specific execution could not be ruled out or confirmed.
- Per the 246 line and the hard constraint, the installer was NOT rebuilt or modified after packaging; the fix (a packaged-mode migrations fallback in the main process) is a source change that would require a new candidate build and a fresh full gate cycle.

### Smoke items not executed (with reasons)

| Planned item | Status | Reason |
| --- | --- | --- |
| Full UI interaction inside the installed app (onboarding click-through, chat UI, citation open in UI) | Not executed | Packaged exe never reaches a window on this machine (diagnosis above); UI-level behavior of the same build is covered by the Task 9 Electron e2e suite (20/20) in dev runtime |
| Overwrite-install over an installed copy with data retention | Not executed | Depends on a functioning installed-app launch to verify retention |
| Uninstaller invocation + user-data retention (`deleteAppDataOnUninstall: false`) | Not executed | Same launch dependency; `deleteAppDataOnUninstall: false` is statically confirmed in `electron-builder.yml` and the NSIS registry entry (`QuietUninstallString ... /currentuser /S`, no delete-app-data flag) |
| Reinstall + retained-data open | Not executed | Same launch dependency |

## Installer immutability (252)

`Get-FileHash -Algorithm SHA256` re-run after all smoke attempts:

`9522DB07D5540788E0254DBED35ACC5DCBB44FB803241B5795750E5298F3EEEF`

Identical to the pre-smoke hash. No `package`/`build` command was run after packaging.

## Clean-machine status (253, honest)

**No independent clean Windows machine was available.** All packaging and smoke attempts ran on the development machine. This is not equivalent to a clean-machine verification and is recorded as such; a fresh-VM or second-machine smoke pass (especially of the packaged-exe launch issue above) remains outstanding.

## Delivery status

The installer is an immutable candidate artifact with verified hash, but per the Completion Gate ("never reuse the failed candidate or claim partial completion") the packaged-exe launch failure and the unexecuted smoke items must be resolved (source fix + new candidate + fresh gates) before this build may be declared the final verified release.

## Task 10 re-verification — Candidate 2 after root-cause fix (2026-08-30)

### Original candidate failure — corrected root cause

Candidate 1 (359,802,370 bytes, SHA-256 `9522DB07D5540788E0254DBED35ACC5DCBB44FB803241B5795750E5298F3EEEF`) failed to open a window. The earlier "migrations ENOENT" hypothesis was an artifact of the reproduction method: running the packaged asar under the dev Electron binary always hits the `app.isPackaged === false` asar-relative migrations branch and explains nothing about the packaged exe. The real packaged-exe failure was captured by dumping the blocking dialog via UI Automation — Electron showed a modal "A JavaScript error occurred in the main process" dialog (process alive, windowless, CDP never opened, stderr empty):

`Error: Cannot find module 'apache-arrow'` — require stack `app.asar/node_modules/@lancedb/lancedb/dist/connection.js`.

`apache-arrow` is a peerDependency of `@lancedb/lancedb@0.37.1` (range `>=15.0.0 <=18.1.0`). electron-builder only walks regular production dependencies into the asar, so the peer never landed in the package (verified by asar listing: installed locally at `node_modules/apache-arrow@18.1.0`, absent from candidate 1's asar). The migrations handling itself was verified correct as-is: all 12 migration SQL files ship under `resources/migrations` via extraResources and the packaged branch resolves there, so no main-process change was needed.

### Fix (minimal, TDD)

- `package.json`: added `"apache-arrow": "18.1.0"` to `dependencies` (exact pin inside the lancedb peer range; `npm ls apache-arrow` shows the top-level entry deduped into `@lancedb/lancedb`).
- New regression test `src/main/db/packaged-dependencies.test.ts`, written RED first (failed while the dependency was missing) and GREEN after the fix: asserts every non-`@types` runtime peerDependency of `@lancedb/lancedb` is declared by the app, so the packaged dependency closure cannot silently lose a peer again.
- `scripts/installer-smoke.mjs`: corrected the `restart-active-space` and `overwrite-data-retained` assertions to the real `vectorHealthSchema` contract (`{ spaceId, healthy, indexedCount }` — the schema has no `state` field), fixing smoke-script/contract drift rather than product behavior.

### Gates (exact, all green)

| Command | Exit code | Result |
| --- | --- | --- |
| `npm test` | 0 | 108 files / 997 tests passed (includes the new regression test) |
| `npm run typecheck` | 0 | node + web tsc projects clean |
| `npm run build` | 0 | electron-vite production build |
| `npm run test:e2e` | 0 | 20/20 passed (1.6m) |

### Repackage (246 amended)

Two interim `npm run package:win` attempts failed before producing an installer and were retried in place: one `EBUSY` (a stale dev-electron diagnostic process still held `app.asar`; processes closed, no artifact state changed) and one GitHub download `ETIMEDOUT` (network flake). The following run completed with exit code 0 and wrote the new candidate to the same path, replacing the failed candidate 1 (allowed failure-fix-repackage flow).

### New installer identity (247 amended)

| Property | Value |
| --- | --- |
| Path | `D:\fix\mynotebokklm\.worktrees\desktop-foundation\dist\MyNotebookLM-Setup-1.0.0.exe` |
| Byte size | 360,399,111 |
| SHA-256 (pre-smoke) | `2F4A8071EEB053F0AE72DC2DF7F33DC11554DB94DF4916AE478577BF346D599C` |
| Superseded candidate 1 | 359,802,370 bytes, SHA-256 `9522DB07D5540788E0254DBED35ACC5DCBB44FB803241B5795750E5298F3EEEF` |
| Signing | NotSigned (unsigned; SmartScreen warning expected) |

### Packaged-layout verification (new candidate)

- `app.asar` now contains `node_modules/apache-arrow/` (checked `node_modules/apache-arrow/package.json` in the asar listing).
- `app.asar.unpacked` contains `better-sqlite3/prebuilds/win32-x64.node` (loaded via the prebuildify fallback in `lib/binding.js`), the lancedb win32-x64-msvc native module and onnxruntime DLLs.
- Packaged-exe launch smoke with an isolated user-data dir: process alive, CDP opens, page target `title=MyNotebookLM` loading `app.asar/out/renderer/index.html` — the window is created.

### Install smoke results (248–251 amended — full pass)

Run by `scripts/installer-smoke.mjs` against the exact new installer, in a silent-extract isolated install dir and isolated user-data dir with a local 127.0.0.1 fake OpenAI-compatible provider. 18/18 PASS, final line `SMOKE_OK`: silent install; onboarding visible; skip lands home; lancedb health; chat completed ("Grounded alpha answer [S1]"); citation S1 resolves; citation opens; note created; restart persistence (assistant, note, space healthy with indexedCount 1, settings); overwrite install retains data; uninstall removes binaries while user data is kept (`deleteAppDataOnUninstall: false` verified by behavior); reinstall opens the retained data.

### Installer hash re-check (252 amended)

Post-smoke SHA-256 re-run: `2F4A8071EEB053F0AE72DC2DF7F33DC11554DB94DF4916AE478577BF346D599C`, identical to the pre-smoke value. No `package`/`build` command was run after packaging.

### Clean-machine status (253, unchanged)

No independent clean Windows machine was available; all packaging and smoke runs remain on the development machine, recorded honestly as before.

### Delivery status (supersedes the candidate-1 status above)

Candidate 2 passed all gates and the full install smoke, and the delivered file is the exact artifact that passed: `D:\fix\mynotebokklm\.worktrees\desktop-foundation\dist\MyNotebookLM-Setup-1.0.0.exe`, 360,399,111 bytes, SHA-256 `2F4A8071EEB053F0AE72DC2DF7F33DC11554DB94DF4916AE478577BF346D599C`, unsigned. Clean-machine verification remains outstanding as recorded.
