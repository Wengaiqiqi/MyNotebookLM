# MyNotebookLM Complete UI and Final Windows Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Use brainstorming/image generation for the mandatory visual gates, test-driven-development for behavior, requesting-code-review for each task, and verification-before-completion before any release claim.

**Goal:** Turn all completed back-end capabilities into the approved bilingual desktop experience, prove the complete user journey, and package/test exactly one final Windows x64 installer.

**Architecture:** A small React view router renders onboarding, project workspace and settings. Focused feature components use the versioned preload API and ordinary React state/hooks. Root portals own all dialogs. Automated E2E uses deterministic fake providers and fixtures; installer smoke uses the exact final NSIS bytes without a rebuild.

**Tech Stack:** Existing complete stack, React Testing Library through current Vitest/jsdom setup, Playwright Electron, electron-builder/NSIS, Windows PowerShell for installer/hash evidence.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- Do not run `npm run package:win` before Task 10.
- New screens use the existing Foundation UI visual baseline under the written Task 1 exemption dated 2026-08-28; each feature task still requires a real Electron screenshot and Gate F evidence.
- All dialogs center over the whole viewport; backdrop covers sidebar and workspace; focus is trapped and restored.
- Sidebar bottom centers Settings, `中文 | EN`, and `浅色 | 深色`; language/theme controls remain compact.
- Visible actions either work or show a concrete repair action. No permanent disabled placeholder copy.
- Every component state has identical zh-CN/en translation keys and correct light/dark variables.
- Keep render-process Node access disabled and sanitize all generated/source Markdown.

## Task 1: Visual Baseline Decision and Evidence Gate

**Files:**
- Create: `docs/ui/complete/README.md`
- Use as visual baseline: `docs/ui/foundation/README.md` and its five approved PNGs.

- [x] On 2026-08-28, the user gave written approval to waive the seven new generated mockups. Do not run imagegen and do not create the seven PNG files.
- [x] Reuse the approved Foundation UI directly for feature pages; record the baseline, consistency rules, required feature states/actions, and the evidence handoff in `docs/ui/complete/README.md`.
- [x] Defer final page-by-page visual proof to the owning feature tasks and Gate F: capture real Windows Electron screenshots in Chinese/light and English/dark where state differs.

No new visual asset commit is created for this waived gate. The documentation changes remain uncommitted pending independent read-only acceptance and the main model's integration decision.

## Task 2: Refactor the Application Shell Without Changing Behavior

**Files:**
- Create: `src/renderer/src/app/AppShell.tsx`
- Create: `src/renderer/src/app/AppRouter.tsx`
- Create: `src/renderer/src/app/Sidebar.tsx`
- Create: `src/renderer/src/app/ModalRoot.tsx`
- Create: `src/renderer/src/app/ModalRoot.test.tsx`
- Create: `src/renderer/src/projects/ProjectView.tsx`
- Create: `src/main/db/migrations/012_project_deletion.sql` (forward migration; 001–011 are immutable)
- Create: `src/main/projects/project-deletion.test.ts`
- Modify: `src/main/projects/project-repository.ts`
- Modify: `src/main/projects/project-repository.test.ts`
- Modify: `src/main/projects/project-service.ts`
- Modify: `src/main/projects/project-service.test.ts`
- Modify: `src/main/ipc/register-project-handlers.ts`
- Modify: `src/main/index.ts`, `src/main/sources/managed-files.ts`
- Modify: `src/shared/projects.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/create-desktop-api.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.ts`
- Create: `src/preload/project-lifecycle.test.ts`

- [x] Add characterization tests for existing project CRUD, menu focus, dialog focus/geometry, onboarding/settings routing and preference persistence before moving code.
- [x] Extract only the four named responsibilities; keep `App.tsx` as composition entry and avoid a global store/router dependency.
- [x] Add failing repository/service tests and migration fields for `active|deleting|delete_failed`, `deleted_at` and restore. Use forward migration `012_project_deletion.sql`; reuse task `kind='delete'` and stages `cleanup/finalizing`. Replace the old immediate hard delete with a durable project-cleanup task.
- [x] Project deletion first enters a 30-second undo grace state. Restore cancels queued cleanup. After cleanup starts, delete sources/files, Lance rows, conversations, notes, insights and tasks through their owning services, then hard-delete the project in one final SQLite transaction. A failure leaves `delete_failed` with retry/restore actions.
- [x] Add archived project list/restore and deletion undo/retry/restore UI so both archive and delete remain usable and recoverable.
- [x] Re-run characterization tests after every extraction; output/behavior must remain identical.
- [x] Independent read-only review PASS. Main-model evidence: focused `11 files / 150 tests`, full `92 files / 877 tests`, `npm run typecheck`, `npm run build`, and `git diff --check` all passed on 2026-08-28.
- [x] Review and commit `refactor: split desktop application shell`.

## Task 3: Implement Approved Source Import and Task UI

**Files:**
- Create: `src/renderer/src/sources/SourcePanel.tsx`
- Create: `src/renderer/src/sources/SourcePanel.test.tsx`
- Create: `src/renderer/src/sources/ImportDialog.tsx`
- Create: `src/renderer/src/sources/ImportDialog.test.tsx`
- Create: `src/renderer/src/tasks/TaskProgress.tsx`
- Create: `src/renderer/src/tasks/TaskProgress.test.tsx`
- Create: `docs/verification/screenshots/source-import-zh-light.png`
- Create: `docs/verification/screenshots/source-task-error-en-dark.png`
- Modify: `e2e/desktop.spec.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-source-handlers.ts`
- Modify: `src/main/ipc/register-source-handlers.test.ts`
- Modify: `src/main/sources/ingestion-service.ts`
- Modify: `src/main/sources/ingestion-service.test.ts`
- Modify: `src/main/sources/main-source-service.ts`
- Modify: `src/main/sources/main-source-service.test.ts`
- Modify: `src/main/sources/url-source.ts`
- Modify: `src/preload/create-desktop-api.ts`
- Modify: `src/preload/create-desktop-api.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.ts`
- Modify: `src/renderer/src/locales/en.ts`
- Modify: `src/renderer/src/locales/zh-CN.ts`
- Modify: `src/renderer/src/projects/ProjectView.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/shared/sources.ts`

- [x] Write failing tests for file dialog/import URL, every allowed format, unsupported format error, progress stages, cancel, retry, delete, source selection and restart hydration.
- [x] Implement the approved source screens. File input is triggered only by the main-process chooser; URL dialog validates but main remains authoritative.
- [x] Show source locator/type, indexed revision, task status and concrete repair action. Keyboard/screen-reader live regions announce progress no more than once per second.
- [x] Add real Electron screenshots for the source-import and source-task-error states under `docs/verification/screenshots/`; compare against `docs/ui/complete/README.md` and correct visual differences.
- [x] Independent read-only review PASS after repair/re-review. Main-model evidence (2026-08-28): full `95 files / 895 tests`, `npm run typecheck`, `npm run build`, Task 3 Electron E2E `2/2`, and `git diff --check` passed. Screenshots are real Electron `1803x1128` in `zh-CN/light` and `en/dark`; file paths stay main-only, URL redirects are revalidated, and late worker writes are rejected by task/source/revision state checks.
- [x] Review and commit `feat: complete source ingestion interface`.

## Task 4: Implement Approved Vector Health and Migration UI

**Files:**
- Create: `src/renderer/src/vector/IndexStatus.tsx`
- Create: `src/renderer/src/vector/IndexStatus.test.tsx`
- Create: `src/renderer/src/vector/SpaceMigrationDialog.tsx`
- Create: `src/renderer/src/vector/SpaceMigrationDialog.test.tsx`
- Create: `src/renderer/src/model-settings/SettingsView.test.tsx`
- Create: `docs/verification/screenshots/index-space-zh-light.png`
- Create: `docs/verification/screenshots/index-space-en-dark.png`
- Modify: `e2e/desktop.spec.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/sources/ingestion-service.integration.test.ts`
- Modify: `src/main/vector/lance-store.ts`
- Modify: `src/main/vector/lance-store.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/locales/en.ts`
- Modify: `src/renderer/src/locales/zh-CN.ts`
- Modify: `src/renderer/src/model-settings/SettingsView.tsx`
- Modify: `src/renderer/src/styles.css`

- [x] Write failing tests for healthy/unavailable/corrupt/building/failed states, configure-model repair, optimize, rebuild, migrate, cancel and failed migration retaining old Space. Do not expose a manual embedding-model download action; built-in local artifacts remain an internal on-demand concern.
- [x] Implement the approved independent data/index settings page and centered confirmation/progress dialogs; disable only conflicting mutations while a task runs, never unrelated navigation.
- [x] Add real Electron screenshots for the index-space states under `docs/verification/screenshots/`; compare against `docs/ui/complete/README.md` and correct differences.
- [x] Independent read-only review PASS after repair/re-review. Main-model evidence (2026-08-29): focused vector/settings tests `5 files / 54 tests`, full suite `98 files / 916 tests`, `npm run typecheck`, `npm run build`, Task 4 Electron E2E `1/1`, and `git diff --check` passed. The E2E uses a fake OpenAI-compatible embedding profile, confirms migration, and observes its validation task complete. A separate read-only review also passed the Windows-only real-worker integration-test timeout stabilization.
- [x] Review and commit `feat: add complete vector management interface`.

## Task 5: Implement Approved Research Chat and Citations UI

**Files:**
- Create: `src/renderer/src/chat/ChatView.tsx`
- Create: `src/renderer/src/chat/ChatView.test.tsx`
- Create: `src/renderer/src/chat/ConversationList.tsx`
- Create: `src/renderer/src/chat/CitationPanel.tsx`
- Create: `src/renderer/src/chat/CitationPanel.test.tsx`
- Modify: `src/renderer/src/projects/ProjectView.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] Write failing tests for new/select/rename/archive/delete conversation, send, streamed text, stop, copy, regenerate, citations, fallback banner, model override and all repair states.
- [ ] Implement the 2026-08-28 approved direction in `docs/ui/complete/README.md`: source cards/progress above the cited chat, fixed right citation cards, and a large rounded multiline composer whose right controls expose model selection, capability-gated reasoning strength, and send/stop. Omit the reference image's left plus and permission controls. Chat becomes available when at least one source revision is indexed and a generation route exists; otherwise show import/open-settings/rebuild actions.
- [ ] Citation buttons open the in-app detail first, then an explicit original-file/URL action.
- [ ] Preserve scroll position when reading history; auto-follow only if the user remains near the bottom.
- [ ] Add a real Electron screenshot for the research-chat states under `docs/verification/screenshots/`; compare against `docs/ui/complete/README.md` and correct differences.
- [ ] Review and commit `feat: complete cited research chat interface`.

## Task 6: Implement Approved Notes and Transformations UI

**Files:**
- Create: `src/renderer/src/notes/NotesView.tsx`
- Create: `src/renderer/src/notes/NotesView.test.tsx`
- Create: `src/renderer/src/notes/NoteEditor.tsx`
- Create: `src/renderer/src/transformations/TransformationView.tsx`
- Create: `src/renderer/src/transformations/TransformationView.test.tsx`
- Create: `src/renderer/src/transformations/RuleEditorDialog.tsx`
- Modify: `src/renderer/src/projects/ProjectView.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] Write failing tests for note CRUD/archive/restore/link/save conflict/AI title and for built-in/custom rule CRUD/run/cancel/retry/idempotent insight/convert-to-note.
- [ ] Implement approved notes and transformation screens with plain-text Markdown editing plus sanitized preview.
- [ ] Rule editor documents exactly four placeholders and rejects unknown syntax inline.
- [ ] Add real Electron screenshots for the notes and transformations states under `docs/verification/screenshots/`; compare against `docs/ui/complete/README.md` and correct differences.
- [ ] Review and commit `feat: complete notes and transformations interface`.

## Task 7: Implement Approved Model Routing UI and Complete Settings

**Files:**
- Create: `src/renderer/src/model-settings/RouteSettings.tsx`
- Create: `src/renderer/src/model-settings/RouteSettings.test.tsx`
- Create: `src/renderer/src/model-settings/FallbackHistory.tsx`
- Modify: `src/renderer/src/model-settings/SettingsView.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] Write failing tests for per-task route editing, ordered fallback, capability filtering, duplicate prevention, embedding single-profile rule, save errors and fallback history.
- [ ] Implement the approved routing view. Use accessible move-up/move-down buttons instead of pointer-only drag behavior; pointer reordering may be added only if it shares the same commands.
- [ ] Confirm generation and embedding can both be changed from Settings and model discovery/manual input still work.
- [ ] Add a real Electron screenshot for the model-routing states under `docs/verification/screenshots/`; compare against `docs/ui/complete/README.md` and correct differences.
- [ ] Review and commit `feat: complete model routing settings`.

## Task 8: Complete Localization, Themes, Accessibility and Recovery

**Files:**
- Modify: `src/renderer/src/locales/zh-CN.ts`
- Modify: `src/renderer/src/locales/en.ts`
- Modify: `src/renderer/src/i18n.test.ts`
- Modify: `src/renderer/src/styles.css`
- Create: `src/renderer/src/accessibility.test.tsx`
- Modify: `e2e/desktop.spec.ts`

- [ ] Add a failing recursive locale-key/value-shape equality test covering every new view/error/stage/action.
- [ ] Test keyboard traversal, visible focus, dialog trapping/restoration, escape behavior, aria labels/live regions, contrast variable pairs and 200% zoom without clipped primary actions.
- [ ] Test restart recovery for onboarding, theme/language, selected project, in-progress tasks, conversations, notes and active Space.
- [ ] Capture critical screens in zh-CN/light and en/dark. Store under `docs/verification/screenshots/` and list against approved images.
- [ ] Remove every placeholder/disabled title from the old foundation and search for forbidden copy with `rg -n "后续|稍后提供|later step|Unavailable|disabled title" src` (the legitimate onboarding action `稍后配置模型` is the only reviewed exception).
- [ ] Run Gate F from the master plan; review and commit `feat: finish bilingual accessible desktop ui`.

## Task 9: Full Functional, Security and Failure Test Matrix

**Files:**
- Create: `e2e/complete-research-flow.spec.ts`
- Create: `e2e/recovery-and-failures.spec.ts`
- Create: `e2e/security-boundaries.spec.ts`
- Create: `src/test/provider-contract-matrix.test.ts`
- Create: `src/test/document-fixture-matrix.test.ts`
- Create: `docs/release/2026-08-25-verification.md`

- [ ] Run provider matrix: discovery/generation/embedding/stream/cancel/errors for OpenAI, OpenAI-compatible, Anthropic, Gemini and Ollama; local embedding download/inference via controlled artifact/runtime test.
- [ ] Run fixture matrix for all eight source kinds and exact locator assertions.
- [ ] Run the complete desktop chain with fake providers: onboarding -> project -> all imports -> index -> chat/citations -> note/title -> built-in/custom transformations -> allowed fallback -> Space migration -> rebuild -> restart.
- [ ] Run failure chain: skip onboarding, missing model, offline, auth, rate limit, malformed provider response, parser failure, worker crash, cancel, corrupt LanceDB, failed migration and recovery.
- [ ] Run security chain: preload rejection, navigation/window-open denial, secret redaction, source Markdown sanitization, traversal/signature/macro rejection and URL SSRF/redirect/DNS rebinding protections.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e` from a clean output state and record exact exit codes/test counts.
- [ ] Request a final correctness/security review and resolve every high/medium finding with new regression tests.
- [ ] Commit `test: verify complete mynotebooklm product` only when all checks are green.

## Task 10: Create and Smoke-Test the Exact Final Installer

**Files:**
- Modify: `package.json` version to `1.0.0`
- Modify: `electron-builder.yml`
- Finalize: `docs/release/2026-08-25-verification.md`
- Produce once: `dist/MyNotebookLM-Setup-1.0.0.exe`

- [ ] Verify `git status --short`; preserve any unrelated user changes and document them. Confirm all six plan completion gates and the master checklist are checked.
- [ ] Ensure `asarUnpack` covers LanceDB/ONNX/native `.node` assets and packaged migrations/model manifest are in explicit `extraResources`. Test packaged-file inventory before release packaging through the production build output.
- [ ] Confirm no code-signing certificate is silently assumed. If unavailable, record “unsigned” and expected Windows SmartScreen warning; do not claim signing.
- [ ] Remove/replace only the explicitly resolved obsolete files beneath the repository's exact `dist` directory after verifying its absolute path. Do not touch user data or any broad directory.
- [ ] Run the final prepackage suite once more: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`. Stop on any failure.
- [ ] Run `npm run package:win` exactly once. From this point, do not rebuild or edit packaged inputs.
- [ ] Record installer byte size and `Get-FileHash -Algorithm SHA256` immediately.
- [ ] Fresh-install the exact installer for the current user, launch with an isolated fresh user-data directory, confirm onboarding, and execute the representative complete research chain using test-safe local providers without developer server/runtime.
- [ ] Close the app, relaunch and verify projects, sources, conversations, notes, settings and active Space persist.
- [ ] Run the same installer again over the installed copy and verify preserved user data. If an available signed/known `0.1.0` foundation installer is used for true upgrade testing, record its hash separately and never deliver it.
- [ ] Invoke the installed uninstaller, verify binaries/shortcuts are removed and user data remains because `deleteAppDataOnUninstall: false`; reinstall the same final installer and verify retained data can be opened.
- [ ] Hash the original final installer again and assert it exactly equals the pre-smoke SHA-256. Do not run package/build afterward.
- [ ] Finish the evidence ledger, including whether an independent clean Windows machine was actually available. Never substitute a same-machine isolated profile for that claim.
- [ ] Review release evidence and commit only source/docs changes that predate packaging. The installer remains the immutable delivery artifact.

## Completion Gate

Only after Task 10 succeeds may MyNotebookLM be called complete or the installer be handed to the user. Delivery must include the exact absolute installer path, byte size, SHA-256, test summary, signing status and honest clean-machine status. If any functional, visual, security or hash check fails, fix source, repeat all impacted gates and create a new candidate; never reuse the failed candidate or claim partial completion.
