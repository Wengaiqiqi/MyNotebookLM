import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfileDto } from "../../shared/models";
import { estimateTokens } from "../chat/context-builder";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ProviderRequestError } from "../models/http-client";
import { classifyProviderError } from "../models/provider-errors";
import type { GenerateRequest, GenerationEvent } from "../models/provider";
import { RoutedGeneration } from "../models/routed-generation";
import { TaskRepository } from "../tasks/task-repository";
import { TaskService } from "../tasks/task-service";
import { NoteRepository } from "./note-repository";
import { TransformationRepository } from "./transformation-repository";
import { TransformationService } from "./transformation-service";
import { SettingsRepository } from "../settings/settings-repository";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";
const RULE = "33333333-3333-4333-8333-333333333333";
const EXCERPT = "Source excerpt:\n";
const input = { projectId: PROJECT, noteId: NOTE, transformationId: RULE, language: "zh-CN" as const };

function profile(id = "primary", contextTokens = 4096, outputTokens = 512): ModelProfileDto {
  return { id, name: id, provider: "openai", capability: "generation", baseUrl: "https://example.test", modelId: id,
    enabled: true, contextTokensOverride: contextTokens, maxOutputTokensOverride: outputTokens,
    createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" };
}

function excerpt(request: GenerateRequest): string | undefined {
  const prompt = request.messages[0]!.content;
  return prompt.startsWith("Condense this source excerpt") ? prompt.slice(prompt.indexOf(EXCERPT) + EXCERPT.length) : undefined;
}

async function* answer(text: string, finishReason = "stop"): AsyncGenerator<GenerationEvent> {
  yield { type: "text-delta", text };
  yield { type: "usage", inputTokens: 10, outputTokens: 4 };
  yield { type: "done", finishReason };
}

describe("Transformation full input through real model routing", () => {
  let root: string;
  let db: AppDatabase;
  let service: TransformationService;
  let tasks: TaskService;
  let profiles: ModelProfileDto[];
  let requests: Array<{ profile: ModelProfileDto; request: GenerateRequest }>;
  let respond: (request: GenerateRequest, profile: ModelProfileDto) => AsyncIterable<GenerationEvent>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-full-input-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    db.connection.prepare("INSERT INTO projects(id, name) VALUES (?, 'Research')").run(PROJECT);
    db.connection.prepare("INSERT INTO notes(id, project_id, title, body) VALUES (?, ?, 'Long note', 'Short text')").run(NOTE, PROJECT);
    const transformations = new TransformationRepository(db.connection);
    transformations.create({ id: RULE, projectId: PROJECT, name: "Summarize", appliesTo: "note", prompt: "Summarize the following material in {{language}}:\n{{content}}" });
    const taskRepository = new TaskRepository(db.connection);
    tasks = new TaskService(taskRepository, { now: () => new Date().toISOString(), random: () => 0, id: () => crypto.randomUUID() });
    profiles = [profile()];
    requests = [];
    respond = (request) => {
      const part = excerpt(request);
      return answer(part === undefined ? "Final result" : "compact " + (part.match(/\[(?:START|MIDDLE|TAIL)\]/g) ?? []).join(" "));
    };
    const router = { resolve: (_task: unknown, override?: string) => override
      ? [...profiles.filter((item) => item.id === override), ...profiles.filter((item) => item.id !== override)] : profiles };
    const generation = new RoutedGeneration({ db: db.connection, router, providerFactory: (current) => ({
      discover: async () => [], embed: async () => [], generate: (request) => {
        requests.push({ profile: current, request });
        return respond(request, current);
      }
    }) });
    service = new TransformationService({ db: db.connection, tasks, taskRepository, transformations, notes: new NoteRepository(db.connection), router, generation });
  });

  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  function setBody(body: string): void {
    db.connection.prepare("UPDATE notes SET body = ? WHERE id = ?").run(body, NOTE);
  }

  function task(): { id: string; state: string; error_message: string } {
    return db.connection.prepare("SELECT id, state, error_message FROM tasks ORDER BY created_at DESC LIMIT 1").get() as any;
  }

  function expectWithinSharedWindows(): void {
    for (const { request, profile: current } of requests) {
      const context = current.contextTokensOverride!;
      expect(estimateTokens(request.messages[0]!.content) + 72 + request.maxTokens! + Math.max(512, Math.ceil(context * 0.1))).toBeLessThanOrEqual(context);
    }
  }

  it("sends a note well above 12000 tokens intact when the model can fit it", async () => {
    profiles = [profile("large", 131072, 8192)];
    const body = "资料🙂 with facts\n".repeat(4000) + "[TAIL]";
    setBody(body);
    const result = await service.run(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.messages[0]!.content).toContain(body);
    expect(requests[0]!.request.maxTokens).toBe(8192);
    const snapshot = db.connection.prepare("SELECT input_snapshot_json, rendered_prompt_version FROM transformation_task_snapshots WHERE task_id=?").get(result.taskId) as any;
    expect(JSON.parse(snapshot.input_snapshot_json)).toMatchObject({ content: body, truncated: false });
    expect(snapshot.rendered_prompt_version).toBe("transformation-prompt-full-input-v2");
    expectWithinSharedWindows();
  });
  it("sends full input directly for an unknown model under the 1M default", async () => {
    profiles = [{ ...profile("unidentified"), contextTokensOverride: null, maxOutputTokensOverride: null }];
    const body = "完整资料🙂 with facts\n".repeat(6000) + "[TAIL]";
    setBody(body);
    await service.run(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.messages[0]!.content).toContain(body);
    expect(requests[0]!.request.maxTokens).toBe(8192);
    expect(estimateTokens(requests[0]!.request.messages[0]!.content) + 72 + 8192 + 100_000).toBeLessThan(1_000_000);
  });

  it("sends a 53k-character source directly to official MiMo without unnecessary condensation", async () => {
    const settings = new SettingsRepository(db.connection);
    const id = "44444444-4444-4444-8444-444444444444";
    settings.saveProfile({ id, name: "MiMo", provider: "openai", capability: "generation", baseUrl: "https://api.xiaomimimo.com/v1", modelId: "mimo-v2.6-flash", enabled: true });
    profiles = [settings.getProfile(id)!];
    const body = "[START]" + "论文中文资料与研究事实\n".repeat(4500) + "[TAIL]";
    setBody(body);
    respond = () => answer(JSON.stringify({ root: { title: "完整导图", refs: [] } }));
    await service.run({ projectId: PROJECT, noteId: NOTE, builtinKey: "mind-map", language: "zh-CN" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.messages[0]!.content).toContain(body);
    expect(requests[0]!.request.maxTokens).toBe(8192);
    expect(profiles[0]!.generationLimits!.contextWindowTokens).toBe(1_000_000);
  });

  it("processes every Unicode character and includes the middle and tail in the final request", async () => {
    const body = "[START]" + "资料🙂 facts\n".repeat(1200) + "[MIDDLE]" + "more 𠮷 facts\n".repeat(1200) + "[TAIL]";
    setBody(body);
    const result = await service.run(input);
    const parts = requests.map(({ request }) => excerpt(request)).filter((value): value is string => value !== undefined);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join("")).toBe(body);
    expect(requests.at(-1)!.request.messages[0]!.content).toMatch(/\[START\][\s\S]*\[MIDDLE\][\s\S]*\[TAIL\]/);
    expect(result.usage).toEqual({ inputTokens: requests.length * 10, outputTokens: requests.length * 4, totalTokens: requests.length * 14 });
    expectWithinSharedWindows();
  });

  it("preserves source block provenance when a block spans condensation requests", async () => {
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    setBody(ids.map((id) => `[CHUNK:${id}]\n` + "关联事实与原文🙂\n".repeat(1200)).join("\n"));
    // Even if a condensation model drops labels, the application retains the
    // authoritative labels of every source block supplied to that request.
    respond = (request) => answer(excerpt(request) === undefined ? "Final result" : "Compact factual notes");
    await service.run(input);
    const final = requests.at(-1)!.request.messages[0]!.content;
    ids.forEach((id) => expect(final).toContain(`[CHUNK:${id}]`));
    expect(requests.length).toBeGreaterThan(3);
    expectWithinSharedWindows();
  });

  it("reduces summaries in further rounds when one round still exceeds capacity", async () => {
    profiles = [profile("small", 2048, 128)];
    const body = "[START]" + "原始资料🙂\n".repeat(5000) + "[TAIL]";
    setBody(body);
    respond = (request) => {
      const part = excerpt(request);
      return answer(part === undefined ? "Final result" : "compact ".repeat(45) + (part.match(/\[(?:START|MIDDLE|TAIL)\]/g) ?? []).join(" "));
    };
    await service.run(input);
    const parts = requests.map(({ request }) => excerpt(request)).filter((value): value is string => value !== undefined);
    expect(parts.filter((part) => !part.includes("compact")).join("")).toBe(body);
    expect(parts.some((part) => part.includes("compact"))).toBe(true);
    expect(requests.at(-1)!.request.messages[0]!.content).toMatch(/\[START\][\s\S]*\[TAIL\]/);
    expectWithinSharedWindows();
  });

  it("adapts the full source to a smaller fallback model instead of reusing the primary budget", async () => {
    profiles = [profile("primary", 65536, 8192), profile("fallback", 4096, 512)];
    const body = "[START]" + "source facts ".repeat(1600) + "[TAIL]";
    setBody(body);
    const original = respond;
    respond = (request, current) => current.id === "primary" ? (async function* () {
      throw new ProviderRequestError(classifyProviderError({ timeout: true }));
    })() : original(request, current);
    const result = await service.run(input);
    expect(result.model).toBe("fallback");
    expect(requests[0]!.request.messages[0]!.content).toContain(body);
    const parts = requests.filter((item) => item.profile.id === "fallback").map(({ request }) => excerpt(request)).filter((value): value is string => value !== undefined);
    expect(parts.join("")).toBe(body);
    expect(requests.at(-1)!.request.maxTokens).toBe(512);
    expectWithinSharedWindows();
  });

  it("falls back when a later preparation call times out and starts again from all source material", async () => {
    profiles = [profile("primary", 8192, 512), profile("fallback", 4096, 512)];
    const body = "[START]" + "source facts ".repeat(4000) + "[TAIL]";
    setBody(body);
    const original = respond;
    let primaryCalls = 0;
    respond = (request, current) => current.id === "primary" && ++primaryCalls === 2 ? (async function* () {
      throw new ProviderRequestError(classifyProviderError({ timeout: true }));
    })() : original(request, current);
    const result = await service.run(input);
    expect(result.model).toBe("fallback");
    const parts = requests.filter((item) => item.profile.id === "fallback").map(({ request }) => excerpt(request)).filter((value): value is string => value !== undefined);
    expect(parts.join("")).toBe(body);
    expectWithinSharedWindows();
  });

  it("processes every source in a project, including the tail of the final source", async () => {
    for (const [index, title] of ["First source", "Last source"].entries()) {
      const sourceId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      db.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', ?, 'active')").run(sourceId, PROJECT, title);
      db.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, 'a.txt', 'a.txt', ?, 'offset', 'v1', 'ready')").run(revisionId, sourceId, `hash-${index}`);
      db.connection.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
      db.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, 0, ?, '{}', ?)").run(crypto.randomUUID(), revisionId, `${title}\n` + "facts ".repeat(4000) + "[TAIL]", `chunk-${index}`);
    }
    const result = await service.run({ projectId: PROJECT, projectTarget: true, builtinKey: "summary", language: "zh-CN" });
    const snapshot = db.connection.prepare("SELECT input_snapshot_json FROM transformation_task_snapshots WHERE task_id=?").get(result.taskId) as any;
    const saved = JSON.parse(snapshot.input_snapshot_json);
    const parts = requests.map(({ request }) => excerpt(request)).filter((value): value is string => value !== undefined);
    expect(parts.join("")).toBe(saved.content);
    expect(saved.content).toContain("First source");
    expect(saved.content).toContain("Last source");
    expect(requests.at(-1)!.request.messages[0]!.content.match(/\[TAIL\]/g)).toHaveLength(2);
    expectWithinSharedWindows();
  });

  it("resumes from the full saved input and uses updated capacity even after the note changes", async () => {
    const body = "original ".repeat(4000) + "[TAIL]";
    setBody(body);
    const original = respond;
    let fail = true;
    respond = (request, current) => fail && excerpt(request) === undefined ? (async function* () {
      throw new ProviderRequestError(classifyProviderError({ timeout: true }));
    })() : original(request, current);
    await expect(service.run(input)).rejects.toMatchObject({ error: { code: "TIMEOUT" } });
    const savedTask = task();
    setBody("Changed note must not replace the saved input");
    profiles = [profile("primary", 131072, 8192)];
    fail = false;
    requests = [];
    const result = await service.resume(savedTask.id);
    expect(result.taskId).toBe(savedTask.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.messages[0]!.content).toContain(body);
    expect(task().state).toBe("completed");
  });

  it.each(["signal", "task"])("stops between excerpts when cancelled by %s without saving a partial insight", async (kind) => {
    setBody("source ".repeat(8000));
    const controller = new AbortController();
    respond = () => (async function* () {
      if (kind === "signal") controller.abort();
      else tasks.cancel(task().id);
      yield* answer("partial summary");
    })();
    await expect(service.run({ ...input, signal: controller.signal })).rejects.toMatchObject({ error: { code: "CANCELLED" } });
    expect(requests).toHaveLength(1);
    expect(task().state).toBe("cancelled");
    expect(service.listInsights({ projectId: PROJECT })).toEqual([]);
  });

  it("preserves the classified preparation failure and fails the durable task", async () => {
    setBody("source ".repeat(8000));
    respond = () => (async function* () { throw new ProviderRequestError(classifyProviderError({ status: 401 })); })();
    await expect(service.run(input)).rejects.toMatchObject({ error: { code: "AUTH" } });
    expect(task()).toMatchObject({ state: "failed", error_message: "errors.authentication" });
    expect(service.listInsights({ projectId: PROJECT })).toEqual([]);
  });

  it("fails explicitly when summaries do not get smaller instead of dropping material or looping", async () => {
    setBody("source ".repeat(8000));
    respond = (request) => answer(excerpt(request)!);
    await expect(service.run(input)).rejects.toMatchObject({ error: { messageKey: "errors.transformationReductionFailed" } });
    expect(requests.length).toBeLessThan(30);
    expect(task().state).toBe("failed");
    expect(service.listInsights({ projectId: PROJECT })).toEqual([]);
  });

  it.each([false, true])("rejects an incomplete %s output without saving it as a completed transformation", async (long) => {
    if (long) setBody("source ".repeat(8000));
    respond = () => answer("cut-off text", "length");
    await expect(service.run(input)).rejects.toMatchObject({ error: { messageKey: "errors.transformationOutputIncomplete" } });
    expect(task().state).toBe("failed");
    expect(service.listInsights({ projectId: PROJECT })).toEqual([]);
  });

  it("keeps input-only capacity separate from the output reserve", async () => {
    const current = profile("input-only", 4096, 8192);
    current.generationLimits = { windowKind: "input-only", inputTokenLimit: 4096, maxOutputTokens: 8192, source: "provider",
      observedAt: current.updatedAt, identity: { provider: current.provider, baseUrl: current.baseUrl, modelId: current.modelId } };
    profiles = [current];
    const body = "x".repeat(5000);
    setBody(body);
    await service.run(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.maxTokens).toBe(8192);
    expect(requests[0]!.request.messages[0]!.content).toContain(body);
  });

  it.each([false, true])("reprocesses full mind-map excerpts after an output limit (empty=%s)", async (empty) => {
    profiles = [profile("map-model", 32768, 8192)];
    const body = "[START]" + "完整资料🙂\n".repeat(5000) + "[TAIL]";
    setBody(body);
    respond = (request) => {
      const part = excerpt(request);
      if (part === undefined) return answer(JSON.stringify({ root: { title: "完整导图", summary: "涵盖全部资料", refs: [], children: [{ title: "尾部结论", refs: [] }] } }));
      expect(request.thinking).toBe("off");
      expect(request.maxTokens).toBe(8192);
      return part.length > 6000 ? answer(empty ? "" : "unfinished", "length") : answer("compact " + (part.match(/\[(?:START|TAIL)\]/g) ?? []).join(" "));
    };
    const result = await service.run({ projectId: PROJECT, noteId: NOTE, builtinKey: "mind-map", language: "zh-CN" });
    const successfulParts = requests.map(({ request }) => excerpt(request)).filter((part): part is string => part !== undefined && part.length <= 6000);
    expect(successfulParts.join("")).toBe(body);
    expect(requests.at(-1)!.request.messages[0]!.content).toMatch(/\[START\][\s\S]*\[TAIL\]/);
    expect(JSON.parse(result.content).root.title).toBe("完整导图");
    expect(task().state).toBe("completed");
    expectWithinSharedWindows();
  });

  it("keeps the real output-limit error and generation stage for an incomplete map", async () => {
    respond = () => answer('{"root":{"title":"unfinished', "length");
    await expect(service.run({ projectId: PROJECT, noteId: NOTE, builtinKey: "mind-map" })).rejects.toMatchObject({ error: { messageKey: "errors.transformationOutputIncomplete" } });
    const saved = new TaskRepository(db.connection).findById(task().id);
    expect(saved).toMatchObject({ state: "failed", stage: "generating", transformationKind: "mind-map", error: { messageKey: "errors.transformationOutputIncomplete" } });
    expect(saved!.progress).toBeLessThan(900);
    expect(service.listInsights({ projectId: PROJECT })).toEqual([]);
  });

  it("reports instructions that cannot fit before contacting the provider", async () => {
    profiles = [profile("small", 2048, 128)];
    db.connection.prepare("UPDATE transformations SET prompt = ? WHERE id = ?").run("instruction ".repeat(700) + "{{content}}", RULE);
    await expect(service.run(input)).rejects.toMatchObject({ error: { messageKey: "errors.contextBudgetExceeded" } });
    expect(requests).toEqual([]);
    expect(task().state).toBe("failed");
  });

  it("invalidates completed cached results when model capacity changes", async () => {
    const first = await service.run(input);
    expect((await service.run(input)).id).toBe(first.id);
    expect(requests).toHaveLength(1);
    profiles = [profile("primary", 8192, 512)];
    expect((await service.run(input)).id).not.toBe(first.id);
    expect(requests).toHaveLength(2);
  });
});
