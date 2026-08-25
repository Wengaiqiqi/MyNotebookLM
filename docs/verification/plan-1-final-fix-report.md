# Plan 1 Final Review Fix Report

Date: 2026-08-25
Scope: model connectivity final-review security and keyless-provider corrections
Packaging: intentionally not run

## Security correction

- Added migration `003_credential_binding.sql`. Every credential row now carries a non-null provider and canonical base URL. Existing rows are backfilled from their persisted profile, including canonical root and trailing-slash addresses.
- Credential replacement encryption completes before any database mutation. The profile update and prepared encrypted credential write then execute synchronously in one transaction on the shared SQLite connection.
- Every stored-secret read compares the durable binding with both the persisted profile and the requested canonical connection before DPAPI decryption. A mismatch fails closed without decrypting or constructing a provider request.
- The renderer contract remains unchanged: it receives only `hasCredential` and the fixed mask, never encrypted bytes or binding metadata.
- Standalone credential replacement binds the secret to the profile's currently persisted provider and endpoint.

## Failure evidence

- Injected encryption failure leaves the old profile and old secret unchanged.
- Injected credential `INSERT` failure rolls back the preceding profile update.
- Reopening the database after the injected transaction failure preserves the old pair; a request for the attacker endpoint is rejected before provider construction.
- Endpoint/provider edits with a stored key and no replacement remain rejected. Name/model-only edits retain the existing credential.

## Keyless provider correction

- Credential binding is enforced only when a stored credential exists. A credential-free Ollama profile can be tested and saved after changing to another permitted loopback endpoint.
- OpenAI-compatible continues to show an API-key field, but the field is optional for discovery, testing, onboarding, settings, and save. OpenAI, Anthropic, and Gemini still require a key; Ollama and built-in local hide the field.

## Verification evidence

- Focused credential/model/settings/form suite: 14 files, 192 tests passed.
- Gate A suite: 16 files, 220 tests passed.
- Full Vitest suite: 25 files, 289 tests passed.
- Strict TypeScript typecheck: passed.
- Production Electron build: passed.
- Electron E2E: 5 tests passed, including model/route persistence across restart.
- Optional hardening regressions cover raw response byte limits, split multibyte UTF-8 SSE/NDJSON, and malformed Gemini/Ollama vectors. Existing production code passed; no speculative transport change was added.

## Remaining scope note

No installer/package was generated, as required. Verification used this Windows machine; it is not evidence from an independent clean machine.
