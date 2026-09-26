import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { modelOutputKind, type ModelProfileDto } from "../../shared/models";
import type { CredentialStore } from "../credentials/credential-store";
import { ProviderRequestError } from "../models/http-client";
import { RoutedGenerationError } from "../models/routed-generation";
import { parsePodcastScript, synthesizeSpeech } from "../models/speech-provider";

export function validatePodcastRoute(profiles: readonly ModelProfileDto[]): void {
  if (!["text", "speech"].every((kind) => profiles.some((profile) => modelOutputKind(profile) === kind))) {
    throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.podcastRouteMissing", recoverable: true });
  }
}

export class PodcastService {
  constructor(private readonly db: Database.Database, private readonly credentials: Pick<CredentialStore, "withSecret">) {}

  async render(input: { projectId: string; taskId: string; content: string; profiles: readonly ModelProfileDto[]; signal?: AbortSignal | undefined; progress: (fraction: number) => void }): Promise<{ content: string; wav: Buffer }> {
    const script = parsePodcastScript(input.content);
    const profiles = input.profiles.filter((profile) => modelOutputKind(profile) === "speech");
    const signal = input.signal ?? new AbortController().signal;
    for (const [index, profile] of profiles.entries()) {
      const attemptId = randomUUID(), start = Date.now(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO model_route_attempts(id, project_id, operation_id, task_kind, attempt_order, profile_id, provider, model, is_fallback, started_at, created_at)
        VALUES (?, ?, ?, 'podcast', (SELECT COALESCE(MAX(attempt_order), -1) + 1 FROM model_route_attempts WHERE operation_id = ?), ?, ?, ?, ?, ?, ?)`)
        .run(attemptId, input.projectId, input.taskId, input.taskId, profile.id, profile.provider, profile.modelId, index > 0 ? 1 : 0, now, now);
      const finish = (state: string, code: string | null) => {
        const end = new Date().toISOString();
        this.db.prepare("UPDATE model_route_attempts SET state=?,error_code=?,latency_ms=?,completed_at=?,finished_at=? WHERE id=?").run(state, code, Date.now() - start, end, end, attemptId);
      };
      try {
        const wav = await this.credentials.withSecret(profile.id, { provider: profile.provider, baseUrl: profile.baseUrl }, (apiKey) =>
          synthesizeSpeech(profile, apiKey, script.turns, signal, input.progress));
        if (signal.aborted) throw new RoutedGenerationError({ code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false });
        finish("completed", null);
        return { wav, content: `# ${script.title}\n\n${script.turns.map((turn) => `**${turn.speaker}**: ${turn.text}`).join("\n\n")}` };
      } catch (error) {
        const failure = error instanceof ProviderRequestError ? error.failure : undefined;
        const safe = failure?.error ?? (error instanceof RoutedGenerationError ? error.error : { code: "PROVIDER" as const, messageKey: "errors.providerFailure", recoverable: false });
        const cancelled = signal.aborted || safe.code === "CANCELLED";
        finish(cancelled ? "cancelled" : "failed", cancelled ? "CANCELLED" : safe.code);
        if (!cancelled && failure?.fallbackEligible && index + 1 < profiles.length) continue;
        throw new RoutedGenerationError(cancelled ? { code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false } : safe);
      }
    }
    throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.podcastRouteMissing", recoverable: true });
  }
}
