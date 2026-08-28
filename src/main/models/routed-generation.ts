import type Database from "better-sqlite3";
import type { AppErrorDto } from "../../shared/app-errors";
import type { ModelProfileDto, ModelTaskKind } from "../../shared/models";
import type { GenerateRequest, GenerationEvent, ModelProvider } from "./provider";
import { ModelRouter, type ModelProfileSnapshot } from "./model-router";
import { ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";

export type RoutedGenerateRequest = GenerateRequest & Readonly<{
  /** Main-process-only routing context; never forwarded to a provider. */
  projectId: string;
  operationId: string;
}>;

export type RoutedProfile = Readonly<{
  provider: string;
  model: string;
  profileId: string | null;
}>;

export type FallbackDto = Readonly<{
  attempted: RoutedProfile;
  next: RoutedProfile;
  errorCode: string;
}>;

export type RoutedGenerationEvent =
  | { type: "attempt-started"; attempt: RoutedProfile; attemptOrder: number }
  | { type: "fallback"; attempted: RoutedProfile; next: RoutedProfile; errorCode: string }
  | GenerationEvent
  | { type: "routed-complete"; profile: RoutedProfile };

export type RoutedGenerationDeps = Readonly<{
  db: Database.Database;
  router: Pick<ModelRouter, "resolve">;
  providerFactory: (profile: ModelProfileDto) => ModelProvider;
  clock?: () => Date;
  id?: () => string;
}>;

/** Safe error carrying only the already-classified application error. */
export class RoutedGenerationError extends Error {
  constructor(readonly error: AppErrorDto) {
    super(error.messageKey);
    this.name = "RoutedGenerationError";
  }
}

export class RoutedGeneration {
  constructor(private readonly deps: RoutedGenerationDeps) {}

  generateRouted(
    taskKind: ModelTaskKind,
    request: RoutedGenerateRequest,
    overrideProfileId?: string,
    signal?: AbortSignal
  ): AsyncGenerator<RoutedGenerationEvent> {
    return generateRouted(this.deps, taskKind, request, overrideProfileId, signal);
  }
}

export function createRoutedGeneration(deps: RoutedGenerationDeps): RoutedGeneration {
  return new RoutedGeneration(deps);
}

function safeProviderFailure(reason: unknown): { error: AppErrorDto; fallbackEligible: boolean } {
  if (reason instanceof ProviderRequestError) return reason.failure;
  return {
    error: { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: false },
    fallbackEligible: false
  };
}

function profileDto(profile: ModelProfileSnapshot): RoutedProfile {
  return { provider: profile.provider, model: profile.modelId, profileId: profile.id };
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

/**
 * Runs one generation route. Only transient provider failures can move to the
 * next snapshot; once text or usage escaped, the current attempt is terminal.
 */
export async function* generateRouted(
  deps: RoutedGenerationDeps,
  taskKind: ModelTaskKind,
  request: RoutedGenerateRequest,
  overrideProfileId?: string,
  signal: AbortSignal = new AbortController().signal
): AsyncGenerator<RoutedGenerationEvent> {
  if (taskKind === "embedding") throw new Error("Embedding must not use generation routing");
  if (!request.projectId.trim() || !request.operationId.trim()) throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.validation", recoverable: false });

  const clock = deps.clock ?? (() => new Date());
  const createId = deps.id ?? (() => crypto.randomUUID());
  const profiles = deps.router.resolve(taskKind, overrideProfileId);
  if (profiles.length === 0) throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.generationProfileMissing", recoverable: false });

  const insert = deps.db.prepare(`
    INSERT INTO model_route_attempts(
      id, project_id, operation_id, task_kind, attempt_order, profile_id,
      provider, model, state, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)
  `);
  const finish = deps.db.prepare(`
    UPDATE model_route_attempts
    SET state = ?, error_code = ?, latency_ms = ?, completed_at = ?, finished_at = ?
    WHERE id = ? AND state = 'started'
  `);

  let lastError: AppErrorDto | undefined;
  for (let attemptOrder = 0; attemptOrder < profiles.length; attemptOrder += 1) {
    const profile = profiles[attemptOrder]!;
    const current = profileDto(profile);
    const started = clock();
    const startedAt = started.toISOString();
    const attemptId = createId();
    const persistedProfileId = deps.db.prepare("SELECT 1 FROM model_profiles WHERE id = ?").get(profile.id) ? profile.id : null;
    insert.run(attemptId, request.projectId, request.operationId, taskKind, attemptOrder, persistedProfileId, profile.provider, profile.modelId, startedAt, startedAt);
    let emittedNormalEvent = false;
    let sawDone = false;
    let pendingDone: Extract<GenerationEvent, { type: "done" }> | undefined;
    let terminal = false;
    const completeAttempt = (state: "completed" | "failed" | "cancelled", errorCode: string | null): void => {
      if (terminal) return;
      terminal = true;
      const completedAt = nowIso(clock);
      finish.run(state, errorCode, Math.max(0, clock().getTime() - started.getTime()), completedAt, completedAt, attemptId);
    };

    try {
      yield { type: "attempt-started", attempt: current, attemptOrder };
      if (signal.aborted) {
        completeAttempt("cancelled", "CANCELLED");
        throw new RoutedGenerationError({ code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false });
      }
      // Deliberately destructure away main-only routing context at this boundary.
      const { projectId: _projectId, operationId: _operationId, ...providerInput } = request;
      void _projectId;
      void _operationId;
      const providerRequest = { ...providerInput, model: profile.modelId };
      for await (const event of deps.providerFactory(profile).generate(providerRequest, signal)) {
        if (signal.aborted) {
          completeAttempt("cancelled", "CANCELLED");
          throw new RoutedGenerationError({ code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false });
        }
        if (sawDone) throw new ProviderRequestError(classifyProviderError({ malformedResponse: true }));
        if (event.type === "text-delta" || event.type === "usage") emittedNormalEvent = true;
        if (event.type === "done") {
          sawDone = true;
          pendingDone = event;
          continue;
        }
        yield event;
      }
      if (signal.aborted) {
        completeAttempt("cancelled", "CANCELLED");
        throw new RoutedGenerationError({ code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false });
      }
      if (!sawDone) {
        const incomplete = { code: "PROVIDER", messageKey: "errors.providerIncomplete", recoverable: false } satisfies AppErrorDto;
        completeAttempt("failed", incomplete.code);
        throw new RoutedGenerationError(incomplete);
      }
      completeAttempt("completed", null);
      yield pendingDone!;
      yield { type: "routed-complete", profile: current };
      return;
    } catch (reason) {
      if (reason instanceof RoutedGenerationError && reason.error.code === "CANCELLED") throw reason;
      const failure = safeProviderFailure(reason instanceof RoutedGenerationError ? reason.error : reason);
      lastError = failure.error;
      if (signal.aborted || failure.error.code === "CANCELLED") {
        completeAttempt("cancelled", "CANCELLED");
        throw new RoutedGenerationError({ code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false });
      }
      completeAttempt("failed", failure.error.code);
      const nextProfile = profiles[attemptOrder + 1];
      if (!sawDone && !emittedNormalEvent && failure.fallbackEligible && nextProfile) {
        const next = profileDto(nextProfile);
        yield { type: "fallback", attempted: current, next, errorCode: failure.error.code };
        continue;
      }
      throw new RoutedGenerationError(lastError);
    } finally {
      // Consumer return()/break closes this generator without entering catch.
      completeAttempt("cancelled", "CANCELLED");
    }
  }
  throw new RoutedGenerationError(lastError ?? { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: false });
}
