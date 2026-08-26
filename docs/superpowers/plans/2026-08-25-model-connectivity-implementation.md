# MyNotebookLM Model Connectivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Execute tasks in order, apply test-driven-development to every behavior, and request code review after each task.

**Goal:** Make first launch, settings, protected credentials, model discovery, model validation and generation/embedding provider connectivity fully functional.

**Architecture:** Main-process repositories persist non-secret model metadata in SQLite and encrypted secrets with Electron `safeStorage`. Provider adapters use native `fetch` behind one typed interface. The preload exposes DTOs only; React owns transient form state but never receives a stored plaintext key.

**Tech Stack:** Existing foundation plus Electron `safeStorage`, Node native `fetch`/`AbortController`, Zod.

**Spec:** `docs/superpowers/specs/2026-08-25-mynotebooklm-complete-single-release-design.md`

## Global Constraints

- Use the approved onboarding/settings images and current sidebar; do not redesign them.
- Provider defaults are editable and never accompanied by an “auto matched” label.
- Show `获取成功` only after an actual successful discovery response.
- Both generation and embedding allow discovered dropdown selection and manual model input.
- Anthropic is generation-only. Built-in local is embedding-only. Ollama local requires no API key.
- Stored secrets remain decryptable only in main; renderer receives `hasCredential` and a mask, never ciphertext/plaintext.
- Provider calls have a default 30-second timeout, cancellation and normalized errors.
- No packaging in this plan.

**Provider address defaults:** OpenAI `https://api.openai.com/v1`; OpenAI-compatible starts from the OpenAI default but remains freely editable; Anthropic `https://api.anthropic.com`; Gemini `https://generativelanguage.googleapis.com`; Ollama `http://127.0.0.1:11434`. Selecting a provider writes its default only when the address is empty or still equals the previous provider's untouched default; it never overwrites an address the user edited.

## Task 1: Add Settings and Model Schema

**Files:**
- Create: `src/main/db/migrations/002_settings_models.sql`
- Create: `src/shared/app-errors.ts`
- Create: `src/shared/models.ts`
- Create: `src/shared/settings.ts`
- Create: `src/main/settings/settings-repository.ts`
- Create: `src/main/settings/settings-repository.test.ts`
- Modify: `src/main/db/database.test.ts`

**Interfaces:** `AppErrorDto`, `ProviderKind`, `ModelCapability`, `ModelProfileDto`, `ModelRouteDto`, `AppSettingsDto`, `SettingsRepository`.

- [x] Write failing migration/repository tests for default onboarding state, locale/theme persistence, profile CRUD, unique profile IDs, generation/embedding capability validation and route ordering.
- [x] Add migration tables `app_settings`, `model_profiles`, `model_routes`, `credentials`; use ISO timestamps, foreign keys, unique route position and `CHECK` constraints for enumerations.
- [x] Add strict Zod schemas and infer DTOs from them. Provider kinds are `openai`, `openai-compatible`, `anthropic`, `gemini`, `ollama`, `local`; capabilities are `generation`, `embedding`.
- [x] Implement SQL-only repository methods and transactions; do not decrypt credentials here.
- [x] Run `npm test -- --run src/main/db/database.test.ts src/main/settings/settings-repository.test.ts`; expect all focused tests green.
- [x] Run `npm run typecheck`, review and commit `feat: add settings and model persistence`.

## Task 2: Protect Credentials with DPAPI

**Files:**
- Create: `src/main/credentials/credential-store.ts`
- Create: `src/main/credentials/credential-store.test.ts`
- Create: `src/main/credentials/safe-storage-adapter.ts`
- Modify: `src/main/index.ts`

**Interfaces:**

```ts
interface SecretProtector {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}
interface CredentialStore {
  set(profileId: string, apiKey: string): Promise<void>;
  remove(profileId: string): void;
  status(profileId: string): { hasCredential: boolean; mask?: string };
  withSecret<T>(profileId: string, use: (apiKey?: string) => Promise<T>): Promise<T>;
}
```

- [x] Write failing tests proving encrypted bytes differ from input, replacing/removing works, empty secrets are rejected, masks reveal no secret characters and secret text never appears in thrown errors.
- [x] Adapt Electron async `safeStorage`; fail closed when encryption is unavailable. Unit tests inject a deterministic fake protector, never Electron itself.
- [x] Store encrypted blobs in `credentials`; do not expose a general `getSecret` method to IPC.
- [x] Wire the store after `app.whenReady()` and close repositories during shutdown.
- [x] Run `npm test -- --run src/main/credentials`; expect all tests green, then `npm run typecheck`.
- [x] Review and commit `feat: protect model credentials with safe storage`.

## Task 3: Build Provider Contract and Error Classifier

**Files:**
- Create: `src/main/models/provider.ts`
- Create: `src/main/models/provider-errors.ts`
- Create: `src/main/models/provider-errors.test.ts`
- Create: `src/main/models/http-client.ts`
- Create: `src/main/models/http-client.test.ts`

**Interfaces:**

```ts
interface ModelDescriptor { id: string; displayName: string; capabilities: ModelCapability[] }
interface GenerateRequest { model: string; messages: ChatTurn[]; temperature?: number; maxTokens?: number }
interface EmbeddingRequest { model: string; inputs: string[]; dimensions?: number }
type GenerationEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'done'; finishReason?: string };
interface ModelProvider {
  discover(signal: AbortSignal): Promise<ModelDescriptor[]>;
  generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<number[][]>;
}
```

- [x] Write failing tests for timeout, explicit abort, 401/403 auth, 404 invalid model, 429 retry metadata, 5xx recoverable provider error, malformed JSON and secret redaction.
- [x] Implement one native-fetch helper with URL joining, response size limit, JSON/SSE/NDJSON readers and `AbortSignal.any` timeout composition.
- [x] Implement one central classifier returning `AppErrorDto`; authentication/config/cancel are non-fallback errors, network/timeout/429/5xx are fallback-eligible metadata.
- [x] Run `npm test -- --run src/main/models/http-client.test.ts src/main/models/provider-errors.test.ts`; expect green.
- [x] Review and commit `feat: define provider transport contract`.

## Task 4: Implement OpenAI and OpenAI-Compatible Adapters

**Files:**
- Create: `src/main/models/openai-provider.ts`
- Create: `src/main/models/openai-provider.test.ts`
- Create: `src/main/models/test/fake-provider-server.ts`

**Endpoints:** `GET {baseUrl}/models`, `POST {baseUrl}/chat/completions`, `POST {baseUrl}/embeddings`.

- [x] Start a loopback fake HTTP server in tests and first assert failures for bearer authentication, discovery mapping, SSE text/usage/done events, batch embeddings, malformed vectors, abort and all classified status codes.
- [x] Implement direct REST calls. Default OpenAI address is `https://api.openai.com/v1`; OpenAI-compatible uses the user-editable address.
- [x] Validate that every embedding vector is finite, non-empty and has identical dimension; reject mixed dimensions.
- [x] Run `npm test -- --run src/main/models/openai-provider.test.ts`; expect green.
- [x] Review and commit `feat: connect openai compatible providers`.

## Task 5: Implement Anthropic, Gemini and Ollama Adapters

**Files:**
- Create: `src/main/models/anthropic-provider.ts`
- Create: `src/main/models/anthropic-provider.test.ts`
- Create: `src/main/models/gemini-provider.ts`
- Create: `src/main/models/gemini-provider.test.ts`
- Create: `src/main/models/ollama-provider.ts`
- Create: `src/main/models/ollama-provider.test.ts`

**Endpoints:** Anthropic `GET /v1/models`, `POST /v1/messages`; Gemini `GET /v1beta/models`, `:streamGenerateContent?alt=sse`, `:embedContent`; Ollama `GET /api/tags`, `POST /api/chat`, `POST /api/embed`.

- [x] Write fake-server contract tests for exact headers, model mapping, streaming event mapping, embeddings where supported, abort and errors.
- [x] Implement Anthropic with `x-api-key` and `anthropic-version`; `embed` returns a typed unsupported-capability error before network I/O.
- [x] Implement Gemini with `x-goog-api-key`; filter discovery by supported generation/embedding methods.
- [x] Implement Ollama NDJSON chat and array embeddings. Default address is `http://127.0.0.1:11434`; no key is required for this local default.
- [x] Run `npm test -- --run src/main/models/*-provider.test.ts`; expect all provider contracts green.
- [x] Review and commit `feat: connect anthropic gemini and ollama`.

## Task 6: Add Built-In Local Embedding Profile Metadata

**Files:**
- Create: `src/main/models/local-embedding-profile.ts`
- Create: `src/main/models/local-embedding-profile.test.ts`
- Modify: `src/shared/models.ts`

**Decision:** Register built-in model ID `Xenova/multilingual-e5-small`, 384 dimensions, cosine distance, normalized mean pooling, preprocessing version `e5-query-passage-v1`. Model execution and managed download are implemented in Plan 3.

- [x] Write failing tests for immutable provider/address/model/dimension metadata and no-credential behavior.
- [x] Add the built-in descriptor and disallow editing its base URL/key while allowing selection as embedding default.
- [x] Run focused tests and typecheck; review and commit `feat: register built in embedding model`.

## Task 7: Add Model Service and IPC

**Files:**
- Create: `src/main/models/model-service.ts`
- Create: `src/main/models/model-service.test.ts`
- Create: `src/main/ipc/register-model-handlers.ts`
- Create: `src/main/ipc/register-model-handlers.test.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/create-desktop-api.ts`
- Modify: `src/preload/create-desktop-api.test.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/main/index.ts`

**Desktop API additions:** `settings.get/update`, `models.listProfiles/saveProfile/deleteProfile/discover/test`, `credentials.set/remove`; all return `Result<T>`.

- [x] Write failing service/IPC/preload tests for runtime validation, provider construction, discovery, save-after-test, manual model name, secret-preserving edits and unsubscribe cleanup.
- [x] Implement service orchestration. `test` performs discovery when possible and a minimal capability call only when the manual model cannot be verified from discovery.
- [x] Ensure provider addresses accept only `http:`/`https:` and reject embedded credentials; allow loopback only for Ollama or explicitly selected OpenAI-compatible local endpoints.
- [x] Register handlers once, remove them on teardown and validate both directions with Zod.
- [x] Run focused tests, full preload tests and typecheck; review and commit `feat: expose model settings api`.

## Task 8: Implement Seamless Windows Title Controls and Global Modal Centering

**Files:**
- Modify: `src/main/window.ts`
- Modify: `src/main/window.test.ts`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.ts`

- [x] Write failing tests for `titleBarStyle: 'hidden'`, enabled `titleBarOverlay`, secure web preferences and renderer drag/no-drag classes.
- [x] Update window creation so native `—`, `□`, `×` are embedded into the renderer background. Update overlay symbol color when theme changes through a dedicated validated IPC command.
- [x] Render every dialog under one root-level portal into `document.body`; backdrop uses `position: fixed; inset: 0`; modal uses grid centering over the full viewport.
- [x] Add an E2E geometry assertion: modal center is within 2 CSS pixels of viewport center at default and resized window dimensions.
- [x] Run window/App tests, Electron E2E and typecheck; review and commit `fix: integrate title controls and center dialogs`.

## Task 9: Implement Approved First-Launch and Settings UI

**Files:**
- Create: `src/renderer/src/model-settings/ModelProfileForm.tsx`
- Create: `src/renderer/src/model-settings/ModelProfileForm.test.tsx`
- Create: `src/renderer/src/model-settings/FirstLaunch.tsx`
- Create: `src/renderer/src/model-settings/SettingsView.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/locales/zh-CN.ts`
- Modify: `src/renderer/src/locales/en.ts`
- Modify: `e2e/desktop.spec.ts`

- [x] Write failing component tests for initial routing, provider defaults, editable address, conditional API key, discovery success timing, dropdown/manual entry, validation, skip, save, later settings edits and keyboard/focus behavior.
- [x] Split only the model form/view responsibilities out of `App.tsx`; keep ordinary React state and effects, no state library.
- [x] Implement the approved `first-launch.png` and `settings-models.png`; settings sidebar button must actually open the view.
- [x] On skip, persist onboarding completion and make every model-dependent feature show an “open settings” repair action.
- [x] Add identical zh-CN/en keys and a test that recursively compares locale key sets.
- [x] Run component tests and E2E with fake preload. Capture `docs/verification/screenshots/onboarding-zh-light.png` and `settings-en-dark.png` from real Electron.
- [x] Compare dimensions, centering, control placement and states to approved images; correct differences before review.
- [x] Run Gate A from the master plan; review and commit `feat: complete model onboarding and settings`.

## Completion Gate

This plan is complete when onboarding appears on a fresh profile, skip and save persist across restart, settings opens, native controls blend into the current background, all dialogs center over the entire window, every provider contract passes against a fake server, secrets never cross into renderer/logs, and no installer has been generated.
