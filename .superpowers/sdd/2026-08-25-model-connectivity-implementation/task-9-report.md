# Task 9 Report — Approved First-Launch and Model Settings UI

## Status

Implemented and verified.

## RED evidence

1. `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx`
   - RED: the reusable form module did not exist; after the first implementation, focused failures also caught the missing restored built-in route state, blank saved-model dropdown, and API-key reveal button being included in the key label.
2. `npm test -- --run src/main/models/model-service.test.ts`
   - RED: 2 tests failed because explicit default-route read/write operations did not exist.
3. `npm test -- --run src/main/ipc/register-model-handlers.test.ts src/preload/create-desktop-api.test.ts`
   - RED: 10 tests failed because the versioned, validated default-route channels and Desktop API methods did not exist.
4. `npm test -- --run src/renderer/src/App.test.ts src/renderer/src/locales/locale-parity.test.ts`
   - RED: 4 app tests failed because startup still loaded projects before settings, onboarding/skip/settings views did not exist, and configuration could not save profiles and routes.
5. `npm run test:e2e`
   - RED: the initial acceptance run exposed startup-wait/selector issues and an incomplete fake-provider probe contract. Later runs exposed the fixture's missing indexed embedding vector. Production correctly returned sanitized errors in both malformed-provider cases.
6. Review round 1 — atomic route defaults:
   `npm test -- --run src/main/settings/settings-repository.test.ts src/main/models/model-service.test.ts`
   - RED: 5 tests failed because there was no batch repository operation, the service setter accepted only one capability, and reads trusted only the chat route.
7. Review round 1 — async fencing and localized errors:
   `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx src/renderer/src/i18n.test.ts`
   - RED: 7 tests failed. Mutable controls remained enabled during discovery, stale/reversed completions replaced current state, and sanitized authentication/model-not-found/timeout keys fell back to a generic message.
8. Review round 1 — save locking and retryable settings loading:
   `npm test -- --run src/renderer/src/App.test.ts`
   - RED: the new tests caught both forms remaining editable during persistence and settings load failures being silent and unfocused.
9. Review round 2 — Strict Mode lifecycle replay:
   `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx`
   - RED: 1 of 15 tests failed because the first effect cleanup set the mounted guard false and the replayed setup never restored it; a successful discovery remained stuck in “Fetching…”. The paired true-unmount test stayed quiet and ignored its late completion.

## GREEN evidence

- Model form and accessibility behavior:
  `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx`
  - 1 file, 15 tests passed, including Strict Mode replay and true-unmount lifecycle coverage.
- Review round 2 component regression set:
  `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx src/renderer/src/App.test.ts`
  - 2 files, 44 tests passed.
- Route service behavior:
  `npm test -- --run src/main/models/model-service.test.ts`
  - 1 file, 31 tests passed.
- Versioned IPC/preload route boundary:
  `npm test -- --run src/main/ipc/register-model-handlers.test.ts src/preload/create-desktop-api.test.ts`
  - 2 files, 61 tests passed.
- Review-focused repository/service/IPC/preload/renderer/localization set:
  `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx src/renderer/src/i18n.test.ts src/renderer/src/App.test.ts src/main/settings/settings-repository.test.ts src/main/models/model-service.test.ts src/main/ipc/register-model-handlers.test.ts src/preload/create-desktop-api.test.ts`
  - 7 files, 150 tests passed.
- Final Gate A:
  `npm test -- --run src/main/models src/main/settings src/main/credentials src/preload src/renderer`
  - 15 files, 198 tests passed.
- Static types:
  `npm run typecheck`
  - Node and web TypeScript checks passed.
- Production build:
  `npm run build`
  - Main, preload, and renderer bundles built successfully.
- Electron acceptance:
  `npm run test:e2e`
  - 5 tests passed: fresh onboarding/key conditions, skip/restart/repair, validated save and route persistence across restart, project persistence, and full-viewport modal centering before/after resize.
- Full suite:
  `npm test`
  - 24 files, 268 tests passed.
- Whitespace:
  `git diff --check`
  - No whitespace errors; Git emitted only CRLF conversion notices.

## Implementation and self-review

- Persisted settings gate startup before any project query. Fresh profiles render first launch; skip persists completion; successful onboarding validates both capabilities before saving editable profiles, explicitly sets both default routes, then persists completion.
- Added the smallest explicit `models:v1:get-default-routes` / `models:v1:set-default-routes` Result API. It is strictly Zod-validated and sanitized through main, preload, and renderer. The repository replaces all six generation-task routes and the embedding route in one SQLite transaction, including built-in embedding materialization; an injected mid-insert failure proves full rollback. Reads reject partial or inconsistent generation routes. Built-in local embedding remains immutable and rejected by save/test/credential operations; it is selectable only as an embedding route.
- `ModelProfileForm` implements provider defaults without overwriting edited addresses, conditional key entry, fixed unchanged-key masks, transient reveal, discovery-only success status, capability filtering, discovered/manual model selection, saved-profile restoration, labels, focus, and accessible errors. Discovery is epoch-fenced against stale/reversed completion and unmount; every mutable connection/model control is locked while discovery runs. Both complete forms are also locked while onboarding or settings persistence is in flight.
- The mounted lifecycle guard is restored in every effect setup, so React Strict Mode setup-cleanup-setup replay accepts current discovery results while a real unmount still invalidates the request epoch and prevents late state updates.
- Every sanitized model/provider key emitted by production has actionable English and Chinese copy behind a safe allowlist with a generic fallback. Recursive locale parity and representative authentication/model-not-found/timeout rendering tests pass.
- Settings opens from the real sidebar and can later replace both routes/profiles. Missing generation or embedding routes expose actionable localized “Open settings” controls in every corresponding model-dependent area.
- Settings/open-repair load failures stay in the current view, focus an announced error, and expose a localized retry action. First launch adds the approved no-drag light/dark header switch and distinct model-provider visual marks.
- English and Chinese locale structures are identical under the existing recursive parity test. Locale/theme changes persist through settings and synchronize local rendering/title controls.
- The existing body portal/no-drag/fixed full-viewport modal contract and sidebar functionality remain intact.

## Screenshots and visual comparison

- `docs/verification/screenshots/onboarding-zh-light.png`
- `docs/verification/screenshots/settings-en-dark.png`

Both screenshots were recaptured from real Electron at 1803×1128 and inspected against the 1586×992 approved references. The onboarding header theme control, numbered cards, distinct visual marks, settings navigation/content frame, two-column control alignment, action-bar placement, configured discovery success states, masked keys, dropdown states, and light/dark hierarchy occupy the same relative bands. The settings-only marks were removed after comparison because they do not appear in the approved settings reference. The implemented project sidebar intentionally retains the existing functional differences allowed by the foundation contract.

Playwright's renderer screenshot captures the Electron web contents, not Windows OS chrome, so the native title-bar buttons visible in the approved whole-window references are outside these PNGs. Their structure, native/integrated implementation, menu removal, and resizing behavior remain covered by the Task 8 component/Electron checks; no custom renderer window glyphs were added.

## Concerns

No blocking concerns. The E2E provider is loopback-only test infrastructure; production renderer code uses only the validated `DesktopApi`, and no raw key is stored in local storage or returned after persistence. The third Electron launch now asserts that the embedding profile selected on the second launch—and its route ID—survive restart, alongside locale and theme.
