# Task 6 — Built-In Local Embedding Profile Metadata

## Status

Implemented and committed as `feat: register built in embedding model`.

## Files

- `src/main/models/local-embedding-profile.ts`
- `src/main/models/local-embedding-profile.test.ts`
- `src/shared/models.ts`

## TDD evidence

- RED: focused test failed because `./local-embedding-profile` did not exist.
- GREEN: focused test passed with 2 tests.
- Typecheck: `npm run typecheck` passed.
- Full suite: `npm test` passed with 21 files and 154 tests.

## Implementation and self-review

- Registered the immutable built-in `local`/`embedding` profile for `Xenova/multilingual-e5-small`.
- Fixed metadata is 384 dimensions, cosine distance, mean pooling with normalized output, and preprocessing version `e5-query-passage-v1`.
- The descriptor has an empty base URL, no API-key field, `requiresCredential: false`, and `editable: false`.
- Exposed a typed ID predicate for Task 7 to reject edits and credential operations while retaining the profile ID for embedding-route selection.
- Descriptor and nested metadata are frozen at runtime, in addition to readonly TypeScript types.
- `git diff --check` was clean. Existing unrelated documentation move changes were left untouched.

## Concerns

None. Model download and inference remain deferred to Plan 3 as required.
