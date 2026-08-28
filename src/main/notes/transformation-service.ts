import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { InsightDto, InsightUsage } from "../../shared/transformations";
import { insightDtoSchema } from "../../shared/transformations";
import type { TaskDto } from "../../shared/tasks";
import type { ModelProfileSnapshot } from "../models/model-router";
import type { RoutedGenerationEvent, RoutedGenerateRequest, RoutedGeneration, RoutedProfile } from "../models/routed-generation";
import { RoutedGenerationError } from "../models/routed-generation";
import type { TaskService } from "../tasks/task-service";
import { StaleTaskStateError, type TaskRepository } from "../tasks/task-repository";
import { NoteNotFoundError, type NoteRepository } from "./note-repository";
import { listBuiltinTransformations, type BuiltinTransformationDescriptor } from "./builtin-transformations";
import { renderTransformationPrompt } from "./template-renderer";
import type { TransformationRepository } from "./transformation-repository";
import { estimateTokens } from "../../workers/ingestion/chunker";

const INPUT_TOKEN_BUDGET = 12_000;
const OUTPUT_BYTE_LIMIT = 2 * 1024 * 1024;
const RENDERED_PROMPT_VERSION = "transformation-prompt-v1";

type InputKind = "source" | "sources" | "message" | "answer" | "note";
type Rule = BuiltinTransformationDescriptor | { transformationId: string };

export type TransformationRunRequest = Readonly<{
  projectId: string;
  rule?: Rule;
  transformationId?: string;
  builtinKey?: "summary" | "key-points" | "qa";
  language?: "zh-CN" | "en";
  sourceRevisionId?: string;
  sourceRevisionIds?: readonly string[];
  messageId?: string;
  answerMessageId?: string;
  answer?: string;
  noteId?: string;
  profileId?: string;
  force?: boolean;
  signal?: AbortSignal;
}>;

export type TransformationServiceDeps = Readonly<{
  db: Database.Database;
  tasks: Pick<TaskService, "createTask" | "start" | "advance" | "complete" | "fail" | "retry" | "retryCancelled" | "cancel"> & Partial<Pick<TaskService, "recoverStaleRunning">>;
  taskRepository: Pick<TaskRepository, "findByIdempotencyKey" | "findById">;
  transformations: Pick<TransformationRepository, "get">;
  notes: Pick<NoteRepository, "get" | "create">;
  generation: Pick<RoutedGeneration, "generateRouted">;
  router: { resolve: (taskKind: "summary" | "key-points" | "qa" | "custom-transformation", profileId?: string) => readonly ModelProfileSnapshot[] };
  id?: () => string;
  now?: () => string;
}>;

export class TransformationInProgressError extends Error {
  constructor(readonly taskId: string) { super(`Transformation already running: ${taskId}`); this.name = "TransformationInProgressError"; }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function rowInsight(row: any): InsightDto {
  return insightDtoSchema.parse({
    id: row.id, projectId: row.project_id, transformationId: row.transformation_id,
    taskId: row.task_id, inputKind: row.input_kind, inputHash: row.input_hash,
    ruleVersion: row.rule_version, content: row.content, provider: row.provider,
    model: row.model, profileId: row.profile_id,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at
  });
}

function outputText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replaceAll("\0", "").trim();
  if (!normalized) throw new Error("Transformation output is empty");
  if (Buffer.byteLength(normalized, "utf8") > OUTPUT_BYTE_LIMIT) throw new Error("Transformation output is too large");
  return normalized;
}

function truncateContent(content: string, language: string): { content: string; truncated: boolean } {
  if (estimateTokens(content) <= INPUT_TOKEN_BUDGET) return { content, truncated: false };
  const marker = language === "zh-CN" ? "\n[内容已截断]" : "\n[Content truncated]";
  const points = Array.from(content);
  let low = 0; let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(points.slice(0, mid).join("") + marker) <= INPUT_TOKEN_BUDGET) low = mid;
    else high = mid - 1;
  }
  return { content: points.slice(0, low).join("") + marker, truncated: true };
}

function sourceSnapshot(db: Database.Database, projectId: string, revisionIds: readonly string[]): { content: string; hashes: string[]; title: string } {
  const rows: any[] = [];
  for (const revisionId of revisionIds) {
    const revision = db.prepare(`SELECT sr.id, sr.source_id, sr.source_hash, s.display_name FROM source_revisions sr JOIN sources s ON s.id = sr.source_id WHERE sr.id = ? AND s.project_id = ? AND s.status = 'active' AND sr.state = 'ready'`).get(revisionId, projectId) as any;
    if (!revision) throw new Error("Source revision not found");
    const chunks = db.prepare("SELECT content_hash, text FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(revisionId) as Array<{ content_hash: string; text: string }>;
    rows.push({ id: revision.id, title: revision.display_name, sourceHash: revision.source_hash, chunks: chunks.map((chunk) => ({ hash: chunk.content_hash, text: chunk.text })) });
  }
  return { content: rows.map((row) => `## ${row.title}\n\n${row.chunks.map((chunk: any) => chunk.text).join("\n\n")}`).join("\n\n"), hashes: rows.map((row) => sha256(stable(row))), title: rows.map((row) => row.title).join(", ") };
}

function targetSnapshot(db: Database.Database, input: TransformationRunRequest): { kind: InputKind; content: string; hashes: string[]; title: string; target: Record<string, unknown> } {
  const revisionIds = input.sourceRevisionIds ?? (input.sourceRevisionId ? [input.sourceRevisionId] : []);
  const selectedInputs = [revisionIds.length > 0, input.messageId !== undefined, input.answerMessageId !== undefined, input.answer !== undefined, input.noteId !== undefined].filter(Boolean).length;
  if (selectedInputs !== 1) throw new Error("Exactly one transformation input is required");
  if (revisionIds.length > 0) {
    const result = sourceSnapshot(db, input.projectId, revisionIds);
    return { kind: revisionIds.length === 1 ? "source" : "sources", ...result, target: { revisionIds: [...revisionIds] } };
  }
  const messageId = input.answerMessageId ?? input.messageId;
  if (messageId) {
    const row = db.prepare("SELECT m.id, m.role, m.content, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL").get(messageId, input.projectId) as any;
    if (!row || (input.answerMessageId && row.role !== "assistant")) throw new Error("Message not found");
    return { kind: input.answerMessageId ? "answer" : "message", content: row.content, hashes: [sha256(row.content)], title: row.title, target: { messageId, role: row.role } };
  }
  if (input.answer !== undefined) {
    return { kind: "answer", content: input.answer, hashes: [sha256(input.answer)], title: "Answer", target: { answer: true } };
  }
  if (input.noteId) {
    const row = db.prepare("SELECT id, title, body, version FROM notes WHERE id = ? AND project_id = ? AND deleted_at IS NULL").get(input.noteId, input.projectId) as any;
    if (!row) throw new NoteNotFoundError(input.noteId);
    return { kind: "note", content: row.body, hashes: [sha256(`${row.version}:${row.body}`)], title: row.title, target: { noteId: row.id, version: row.version } };
  }
  throw new Error("Transformation input is required");
}

function resolveRule(input: TransformationRunRequest, deps: TransformationServiceDeps): { id: string; version: number; prompt: string; transformationId: string | null; name: string; appliesTo: string; language?: "zh-CN" | "en"; taskKind: "summary" | "key-points" | "qa" | "custom-transformation" } {
  const rule = input.rule ?? (input.transformationId ? { transformationId: input.transformationId } : input.builtinKey ? listBuiltinTransformations().find((item) => item.key === input.builtinKey && item.language === (input.language ?? "en")) : undefined);
  if (!rule) throw new Error("Transformation rule is required");
  if ("transformationId" in rule) {
    const custom = deps.transformations.get(input.projectId, rule.transformationId);
    if (!custom || !custom.enabled) throw new Error("Transformation rule not found or disabled");
    return { id: custom.id, version: custom.version, prompt: custom.prompt, transformationId: custom.id, name: custom.name, appliesTo: custom.appliesTo, taskKind: "custom-transformation" };
  }
  return { id: `builtin:${rule.key}:${rule.language}`, version: 1, prompt: rule.prompt, transformationId: null, name: rule.name, appliesTo: rule.appliesTo, language: rule.language, taskKind: rule.key };
}

export class TransformationService {
  constructor(private readonly deps: TransformationServiceDeps) {}

  private completedInsight(taskId: string, idempotencyKey?: string | null): InsightDto {
    const row = this.deps.db.prepare("SELECT * FROM insights WHERE task_id = ? OR (? IS NOT NULL AND idempotency_key = ?)").get(taskId, idempotencyKey ?? null, idempotencyKey ?? null) as any;
    if (!row) throw new Error("Completed transformation insight not found");
    return rowInsight(row);
  }

  private claim(taskId: string, stage: "preparing"): { task?: TaskDto; insight?: InsightDto } {
    let current = this.deps.taskRepository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (current.state === "completed") return { insight: this.completedInsight(taskId, current.idempotencyKey) };
    if (current.state === "running" || current.state === "queued") {
      try { return { task: this.deps.tasks.start(taskId, stage) }; }
      catch (error) {
        if (!(error instanceof StaleTaskStateError)) throw error;
        current = this.deps.taskRepository.findById(taskId);
        if (!current) throw error;
        if (current.state === "completed") return { insight: this.completedInsight(taskId, current.idempotencyKey) };
        if (current.state === "running" || current.state === "queued") throw new TransformationInProgressError(taskId);
      }
    }
    try {
      if (current.state === "failed") this.deps.tasks.retry(taskId, stage);
      else if (current.state === "cancelled") this.deps.tasks.retryCancelled(taskId, stage);
    } catch (error) {
      if (!(error instanceof StaleTaskStateError)) throw error;
      current = this.deps.taskRepository.findById(taskId);
      if (!current) throw error;
      if (current.state === "completed") return { insight: this.completedInsight(taskId, current.idempotencyKey) };
      if (current.state === "running" || current.state === "queued") throw new TransformationInProgressError(taskId);
      throw error;
    }
    try { return { task: this.deps.tasks.start(taskId, stage) }; }
    catch (error) {
      if (!(error instanceof StaleTaskStateError)) throw error;
      current = this.deps.taskRepository.findById(taskId);
      if (current?.state === "completed") return { insight: this.completedInsight(taskId, current.idempotencyKey) };
      if (current && (current.state === "running" || current.state === "queued")) throw new TransformationInProgressError(taskId);
      throw error;
    }
  }

  async run(input: TransformationRunRequest): Promise<InsightDto> {
    if (!this.deps.router) throw new Error("Transformation router is required");
    const rule = resolveRule(input, this.deps);
    const target = targetSnapshot(this.deps.db, input);
    const language = input.language ?? rule.language ?? "en";
    const bounded = truncateContent(target.content, language);
    const rendered = renderTransformationPrompt(rule.prompt, { content: bounded.content, sourceTitle: target.title, language, projectName: (this.deps.db.prepare("SELECT name FROM projects WHERE id = ?").get(input.projectId) as any)?.name ?? "" });
    if (rule.appliesTo !== target.kind) throw new Error(`Transformation rule appliesTo ${rule.appliesTo} does not match ${target.kind}`);
    const routes = this.deps.router.resolve(rule.taskKind, input.profileId).map((profile) => ({ profileId: profile.id, provider: profile.provider, model: profile.modelId }));
    if (routes.length === 0) throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.generationProfileMissing", recoverable: false });
    const inputHash = sha256(stable({ kind: target.kind, target: target.target, hashes: target.hashes }));
    const baseKey = sha256(stable({ inputHash, ruleId: rule.id, ruleVersion: rule.version, renderedPromptVersion: RENDERED_PROMPT_VERSION, routes }));
    const idempotencyKey = input.force ? sha256(`${baseKey}:force:${randomUUID()}`) : baseKey;
    const existing = this.deps.taskRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.state === "completed") {
      const row = this.deps.db.prepare("SELECT * FROM insights WHERE task_id = ? OR idempotency_key = ?").get(existing.id, idempotencyKey) as any;
      if (row) return rowInsight(row);
    }
    if (existing?.state === "running") throw new TransformationInProgressError(existing.id);
    let task: TaskDto;
    if (existing?.state === "queued" || existing?.state === "failed" || existing?.state === "cancelled") task = existing;
    else {
      try { task = this.deps.tasks.createTask({ projectId: input.projectId, sourceId: null, kind: "transformation", idempotencyKey }); }
      catch (error) {
        const raced = this.deps.taskRepository.findByIdempotencyKey(idempotencyKey);
        if (raced?.state === "completed") {
          const row = this.deps.db.prepare("SELECT * FROM insights WHERE task_id = ? OR idempotency_key = ?").get(raced.id, idempotencyKey) as any;
          if (row) return rowInsight(row);
        }
        if (raced?.state === "running") throw new TransformationInProgressError(raced.id);
        if (raced?.state === "queued") throw new TransformationInProgressError(raced.id);
        if (raced?.state === "failed") task = this.deps.tasks.retry(raced.id, "preparing");
        else if (raced?.state === "cancelled") task = this.deps.tasks.retryCancelled(raced.id, "preparing");
        else throw error;
      }
    }
    const now = this.deps.now?.() ?? new Date().toISOString();
    const request: RoutedGenerateRequest = { projectId: input.projectId, operationId: task.id, model: "transformation", messages: [{ role: "user", content: rendered }] };
    const snapshotExists = this.deps.db.prepare("SELECT 1 FROM transformation_task_snapshots WHERE task_id = ?").get(task.id);
    if (!snapshotExists) this.deps.db.prepare(`INSERT INTO transformation_task_snapshots(task_id, project_id, input_kind, input_snapshot_json, input_hash, rule_id, transformation_id, rule_version, rendered_prompt_version, rendered_prompt, route_snapshot_json, request_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, input.projectId, target.kind, JSON.stringify({ ...target.target, content: bounded.content, truncated: bounded.truncated, hashes: target.hashes }), inputHash, rule.id, rule.transformationId, rule.version, RENDERED_PROMPT_VERSION, rendered, JSON.stringify({ taskKind: rule.taskKind, profileId: input.profileId ?? null, routes }), JSON.stringify(request), idempotencyKey, now, now);
    const claimed = this.claim(task.id, "preparing");
    if (claimed.insight) return claimed.insight;
    task = claimed.task!;
    this.deps.tasks.advance(task.id, "generating", 200);
    let content = "";
    let usage: InsightUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let actual: { provider: any; model: string; profileId: string | null } | undefined;
    try {
      if (input.signal?.aborted) {
        this.deps.tasks.cancel(task.id);
        throw new RoutedGenerationError({ code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false });
      }
      for await (const event of this.deps.generation.generateRouted(rule.taskKind, request, input.profileId, input.signal)) {
        if (event.type === "text-delta") content += event.text;
        else if (event.type === "usage") {
          usage = {
            inputTokens: usage.inputTokens + (event.inputTokens ?? 0),
            outputTokens: usage.outputTokens + (event.outputTokens ?? 0),
            totalTokens: usage.totalTokens + (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
          };
        }
        else if (event.type === "routed-complete") actual = event.profile;
      }
      const safe = outputText(content);
      this.deps.tasks.advance(task.id, "saving", 900);
      const insightId = this.deps.id?.() ?? randomUUID();
      const persistedProfileId = actual?.profileId && this.deps.db.prepare("SELECT 1 FROM model_profiles WHERE id = ?").get(actual.profileId)
        ? actual.profileId : null;
      this.deps.db.transaction(() => {
        this.deps.db.prepare("INSERT INTO insights(id, project_id, transformation_id, task_id, input_kind, input_hash, rule_version, content, provider, model, profile_id, usage_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(insightId, input.projectId, rule.transformationId, task.id, target.kind, inputHash, rule.version, safe, actual?.provider ?? null, actual?.model ?? null, persistedProfileId, JSON.stringify(usage), idempotencyKey);
        this.deps.tasks.complete(task.id, "saving");
      })();
      return rowInsight(this.deps.db.prepare("SELECT * FROM insights WHERE id = ?").get(insightId));
    } catch (error) {
      const cancelled = input.signal?.aborted || (error instanceof RoutedGenerationError && error.error.code === "CANCELLED");
      if (cancelled) { try { this.deps.tasks.cancel?.(task.id); } catch { /* already cancelled */ } throw error; }
      const current = this.deps.taskRepository.findById(task.id);
      if (current?.state === "running") this.deps.tasks.fail(task.id, { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: false }, false);
      throw error;
    }
  }

  convertToNote(projectId: string, insightId: string): ReturnType<NoteRepository["create"]> {
    const row = this.deps.db.prepare("SELECT * FROM insights WHERE id = ? AND project_id = ?").get(insightId, projectId) as any;
    if (!row) throw new Error("Insight not found");
    const content = outputText(row.content);
    const title = content.split("\n")[0]?.replace(/^#+\s*/, "").trim() || "Transformation result";
    return this.deps.notes.create({ id: this.deps.id?.() ?? randomUUID(), projectId, title: title.slice(0, 200), body: content });
  }

  retry(taskId: string, signal?: AbortSignal): Promise<InsightDto> { return this.resume(taskId, signal); }

  async resume(taskId: string, signal?: AbortSignal): Promise<InsightDto> {
    const task = this.deps.taskRepository.findById(taskId);
    const snapshot = this.deps.db.prepare("SELECT * FROM transformation_task_snapshots WHERE task_id = ?").get(taskId) as any;
    if (!task || !snapshot) throw new Error("Transformation snapshot not found");
    if (task.state === "running") throw new TransformationInProgressError(taskId);
    if (task.state === "completed") {
      const row = this.deps.db.prepare("SELECT * FROM insights WHERE task_id = ?").get(taskId) as any;
      if (row) return rowInsight(row);
      throw new Error("Completed transformation insight not found");
    }
    const claimed = this.claim(taskId, "preparing");
    if (claimed.insight) return claimed.insight;
    const persistedRoute = JSON.parse(snapshot.route_snapshot_json) as { taskKind?: string; profileId?: string | null; routes?: readonly RoutedProfile[] } | readonly RoutedProfile[];
    const routeObject = Array.isArray(persistedRoute) ? undefined : persistedRoute as { taskKind?: string; profileId?: string | null; routes?: readonly RoutedProfile[] };
    const taskKind = routeObject?.taskKind ? routeObject.taskKind as "summary" | "key-points" | "qa" | "custom-transformation" : "custom-transformation";
    const persistedRouteProfileId = routeObject?.profileId ?? undefined;
    const persistedRoutes = routeObject ? routeObject.routes ?? [] : persistedRoute;
    const currentRoutes = this.deps.router.resolve(taskKind, persistedRouteProfileId).map((profile) => ({ profileId: profile.id, provider: profile.provider, model: profile.modelId }));
    if (stable(currentRoutes) !== stable(persistedRoutes)) {
      this.deps.tasks.fail(taskId, { code: "VALIDATION", messageKey: "errors.validation", recoverable: false }, false);
      throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.validation", recoverable: false });
    }
    const request = JSON.parse(snapshot.request_json) as RoutedGenerateRequest;
    let content = "";
    let usage: InsightUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let actual: { provider: any; model: string; profileId: string | null } | undefined;
    try {
      for await (const event of this.deps.generation.generateRouted(taskKind, request, persistedRouteProfileId, signal)) {
        if (event.type === "text-delta") content += event.text;
        else if (event.type === "usage") { usage.inputTokens += event.inputTokens ?? 0; usage.outputTokens += event.outputTokens ?? 0; usage.totalTokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0); }
        else if (event.type === "routed-complete") actual = event.profile;
      }
      const safe = outputText(content);
      this.deps.tasks.advance(taskId, "saving", 900);
      const id = this.deps.id?.() ?? randomUUID();
      const completedProfileId = actual?.profileId && this.deps.db.prepare("SELECT 1 FROM model_profiles WHERE id = ?").get(actual.profileId)
        ? actual.profileId : null;
      this.deps.db.transaction(() => {
        this.deps.db.prepare("INSERT INTO insights(id, project_id, transformation_id, task_id, input_kind, input_hash, rule_version, content, provider, model, profile_id, usage_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, snapshot.project_id, snapshot.transformation_id ?? null, taskId, snapshot.input_kind, snapshot.input_hash, snapshot.rule_version, safe, actual?.provider ?? null, actual?.model ?? null, completedProfileId, JSON.stringify(usage), snapshot.idempotency_key);
        this.deps.tasks.complete(taskId, "saving");
      })();
      return rowInsight(this.deps.db.prepare("SELECT * FROM insights WHERE id = ?").get(id));
    } catch (error) {
      if (signal?.aborted) { try { this.deps.tasks.cancel(taskId); } catch {} }
      else if (this.deps.taskRepository.findById(taskId)?.state === "running") this.deps.tasks.fail(taskId, { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: false }, false);
      throw error;
    }
  }

  recoverStale(graceMs: number): Promise<InsightDto[]> {
    if (!this.deps.tasks.recoverStaleRunning) return Promise.resolve([]);
    const tasks = this.deps.tasks.recoverStaleRunning(graceMs).filter((task) => task.kind === "transformation" && task.state === "queued");
    return Promise.all(tasks.map((task) => this.resume(task.id)));
  }
}

export { INPUT_TOKEN_BUDGET, OUTPUT_BYTE_LIMIT, RENDERED_PROMPT_VERSION };
