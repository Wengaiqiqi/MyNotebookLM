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

## GREEN evidence

- Model form and accessibility behavior:
  `npm test -- --run src/renderer/src/model-settings/ModelProfileForm.test.tsx`
  - 1 file, 8 tests passed.
- Route service behavior:
  `npm test -- --run src/main/models/model-service.test.ts`
  - 1 file, 30 tests passed.
- Versioned IPC/preload route boundary:
  `npm test -- --run src/main/ipc/register-model-handlers.test.ts src/preload/create-desktop-api.test.ts`
  - 2 files, 61 tests passed.
- Final Gate A:
  `npm test -- --run src/main/models src/main/settings src/main/credentials src/preload src/renderer`
  - 15 files, 185 tests passed.
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
  - 24 files, 253 tests passed.
- Whitespace:
  `git diff --check`
  - No whitespace errors; Git emitted only CRLF conversion notices.

## Implementation and self-review

- Persisted settings gate startup before any project query. Fresh profiles render first launch; skip persists completion; successful onboarding validates both capabilities before saving editable profiles, explicitly sets both default routes, then persists completion.
- Added the smallest explicit `models:v1:get-default-routes` / `models:v1:set-default-route` Result API. It is strictly Zod-validated and sanitized through main, preload, and renderer. Built-in local embedding remains immutable and rejected by save/test/credential operations; it is selectable only as an embedding route.
- `ModelProfileForm` implements provider defaults without overwriting edited addresses, conditional key entry, fixed unchanged-key masks, transient reveal, discovery-only success status, capability filtering, discovered/manual model selection, saved-profile restoration, busy states, labels, focus, and accessible errors.
- Settings opens from the real sidebar and can later replace both routes/profiles. Missing generation or embedding routes expose actionable localized “Open settings” controls in every corresponding model-dependent area.
- English and Chinese locale structures are identical under the existing recursive parity test. Locale/theme changes persist through settings and synchronize local rendering/title controls.
- The existing body portal/no-drag/fixed full-viewport modal contract and sidebar functionality remain intact.

## Screenshots and visual comparison

- `docs/verification/screenshots/onboarding-zh-light.png`
- `docs/verification/screenshots/settings-en-dark.png`

Both screenshots were captured from real Electron at 1803×1128 and inspected against the 1585×992 approved references (matching aspect ratio). The onboarding cards, settings navigation/content frame, two-column control alignment, action-bar placement, configured discovery success states, masked keys, dropdown states, and light/dark hierarchy occupy the same relative bands. The implemented project sidebar intentionally retains the existing functional differences allowed by the foundation contract.

## Concerns

No blocking concerns. The E2E provider is loopback-only test infrastructure; production renderer code uses only the validated `DesktopApi`, and no raw key is stored in local storage or returned after persistence.
