import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { StaleTaskStateError, TaskRepository } from "../tasks/task-repository";
import { TaskService } from "../tasks/task-service";
import { NoteRepository } from "./note-repository";
import { TransformationRepository } from "./transformation-repository";
import { TransformationService } from "./transformation-service";
import { ModelRouter } from "../models/model-router";
import { RoutedGeneration } from "../models/routed-generation";
import { ProviderRequestError } from "../models/http-client";
import { classifyProviderError } from "../models/provider-errors";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const CHUNK = "44444444-4444-4444-8444-444444444444";
const NOTE = "55555555-5555-4555-8555-555555555555";
const INSIGHT = "66666666-6666-4666-8666-666666666666";

async function* successful(text = "\r\n  # Result\0\n") {
  yield { type: "text-delta" as const, text };
  yield { type: "usage" as const, inputTokens: 10, outputTokens: 4 };
  yield { type: "done" as const };
  yield { type: "routed-complete" as const, profile: { provider: "openai", model: "test-model", profileId: null } };
}

describe("TransformationService", () => {
  let root: string;
  let db: AppDatabase;
  let service: TransformationService;
  let baseDeps: any;
  let calls: number;
  let nextId: number;
  let taskEvents: string[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-task7-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    db.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT, "Research");
    db.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', 'Source title', 'active')").run(SOURCE, PROJECT);
    db.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, 'a.txt', 'a.txt', 'hash', 'offset', 'v1', 'ready')").run(REVISION, SOURCE);
    db.connection.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(REVISION, SOURCE);
    db.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, 0, 'source text', '{}', 'chunk-hash')").run(CHUNK, REVISION);
    calls = 0;
    nextId = 10;
    taskEvents = [];
    const repository = new TaskRepository(db.connection, { onTransition: (task) => taskEvents.push(`${task.state}:${task.stage}`) });
    const tasks = new TaskService(repository, { now: () => "2026-08-28T00:00:00.000Z", random: () => 0, id: () => `77777777-7777-4777-8777-7777777777${++nextId}` });
    baseDeps = {
      db: db.connection, tasks, taskRepository: repository,
      transformations: new TransformationRepository(db.connection), notes: new NoteRepository(db.connection),
      generation: { generateRouted: async function* () { calls += 1; yield* successful(); } },
      router: { resolve: () => [{ id: "router-profile", name: "router", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId: "router-model", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] },
      id: () => `88888888-8888-4888-8888-8888888888${++nextId}`
    };
    service = new TransformationService(baseDeps);
  });

  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("snapshots a source before generation and persists a normalized insight", async () => {
    const insight = await service.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION });
    expect(insight).toMatchObject({ projectId: PROJECT, inputKind: "source", content: "# Result", provider: "openai", model: "test-model", usage: { totalTokens: 14 } });
    expect(db.connection.prepare("SELECT kind, state, stage FROM tasks WHERE id = ?").get(insight.taskId)).toEqual({ kind: "transformation", state: "completed", stage: "saving" });
    expect(db.connection.prepare("SELECT input_hash, rendered_prompt, route_snapshot_json, transformation_id FROM transformation_task_snapshots WHERE task_id = ?").get(insight.taskId)).toMatchObject({ input_hash: expect.any(String), rendered_prompt: expect.stringContaining("source text"), route_snapshot_json: expect.stringContaining("router-profile"), transformation_id: null });
  });

  it("reuses identical completed work but force creates a new key", async () => {
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    const first = await service.run(input);
    const reused = await service.run(input);
    const forced = await service.run({ ...input, force: true });
    expect(reused.id).toBe(first.id);
    expect(forced.id).not.toBe(first.id);
    expect(calls).toBe(2);
  });

  it("claims a durable task and returns immediately while completing in the background", async () => {
    const ownership: Array<{ taskId: string; owned: boolean }> = [];
    const task = service.startTask({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION }, undefined, undefined, (value) => ownership.push(value));
    expect(task.kind).toBe("transformation");
    expect(ownership).toEqual([{ taskId: task.id, owned: true }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(db.connection.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id)).toEqual({ state: "completed" });
  });

  it("reports completed reuse as not owned", async () => {
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    const completed = await service.run(input);
    const ownership: Array<{ taskId: string; owned: boolean }> = [];
    const reused = service.startTask(input, undefined, undefined, (value) => ownership.push(value));
    expect(reused.id).toBe(completed.taskId);
    expect(ownership).toEqual([{ taskId: completed.taskId, owned: false }]);
  });

  it("keeps interleaved startTask controllers and task ids isolated", async () => {
    const gates = new Map<string, { resolve: () => void }>();
    const signals = new Map<string, AbortSignal>();
    service = new TransformationService({ ...baseDeps, generation: {
      generateRouted: async function* (_kind: any, request: any, _profile: any, signal: AbortSignal) {
        let resolve!: () => void;
        const gate = new Promise<void>((done) => { resolve = done; });
        gates.set(request.operationId, { resolve }); signals.set(request.operationId, signal);
        await gate;
        if (signal.aborted) throw new Error("aborted");
        yield* successful(request.operationId);
      }
    } });
    const firstController = new AbortController(); const secondController = new AbortController();
    const first = service.startTask({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION, force: true }, firstController.signal);
    const second = service.startTask({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION, force: true }, secondController.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstController.abort();
    service.cancelTask({ projectId: PROJECT, taskId: first.id });
    gates.get(first.id)!.resolve(); gates.get(second.id)!.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstController.signal.aborted).toBe(true);
    expect(secondController.signal.aborted).toBe(false);
    expect(db.connection.prepare("SELECT state FROM tasks WHERE id = ?").get(first.id)).toEqual({ state: "cancelled" });
    expect(db.connection.prepare("SELECT state FROM tasks WHERE id = ?").get(second.id)).toEqual({ state: "completed" });
  });

  it("converts an insight to a project-owned note without deleting the insight", async () => {
    const insight = await service.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION });
    const note = service.convertToNote(PROJECT, insight.id);
    expect(note).toMatchObject({ projectId: PROJECT, title: "Result", body: "# Result" });
    expect(db.connection.prepare("SELECT id FROM insights WHERE id = ?").get(insight.id)).toEqual({ id: insight.id });
  });

  it("rejects missing and cross-project cancellation without changing the task", () => {
    const otherProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(otherProject, "Other");
    const task = baseDeps.tasks.createTask({ projectId: PROJECT, sourceId: null, kind: "transformation", idempotencyKey: "cancel-owner" });
    expect(() => service.cancelTask({ projectId: PROJECT, taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toThrow("Transformation task not found");
    expect(() => service.cancelTask({ projectId: otherProject, taskId: task.id })).toThrow("Transformation task not found");
    expect(db.connection.prepare("SELECT state, attempt FROM tasks WHERE id = ?").get(task.id)).toEqual({ state: "queued", attempt: 0 });
  });

  it("accepts note input and includes a visible budget marker", async () => {
    db.connection.prepare("INSERT INTO notes(id, project_id, title, body) VALUES (?, ?, 'Note', ?)").run(NOTE, PROJECT, "word ".repeat(30_000));
    const ruleId = "abababab-abab-4aba-8aba-abababababab";
    new TransformationRepository(db.connection).create({ id: ruleId, projectId: PROJECT, name: "Note rule", appliesTo: "note", prompt: "{{content}}" });
    const insight = await service.run({ projectId: PROJECT, transformationId: ruleId, language: "en", noteId: NOTE });
    const snapshot = db.connection.prepare("SELECT input_kind, input_snapshot_json FROM transformation_task_snapshots WHERE task_id = ?").get(insight.taskId) as { input_kind: string; input_snapshot_json: string };
    expect(snapshot.input_kind).toBe("note");
    expect(JSON.parse(snapshot.input_snapshot_json).content).toContain("Content truncated");
  });

  it("keeps one durable task for a failed run and retries it", async () => {
    let first = true;
    service = new TransformationService({ ...baseDeps,
      generation: { generateRouted: async function* () { calls += 1; if (first) { first = false; throw new Error("temporary"); } yield* successful("ok"); } }
    });
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    await expect(service.run(input)).rejects.toThrow("temporary");
    const retried = await service.run(input);
    expect(retried.content).toBe("ok");
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
    expect(calls).toBe(2);
  });

  it("records cancellation as cancelled and does not call a fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION, signal: controller.signal })).rejects.toThrow();
    expect(db.connection.prepare("SELECT state FROM tasks").get()).toEqual({ state: "cancelled" });
    expect(calls).toBe(0);
  });

  it("fails closed when no router is supplied", async () => {
    const deps = { ...baseDeps };
    delete deps.router;
    const noRouter = new TransformationService(deps);
    await expect(noRouter.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION })).rejects.toThrow(/router|route/i);
    expect(calls).toBe(0);
  });

  it("rejects a non-ready source revision before provider use", async () => {
    db.connection.prepare("UPDATE source_revisions SET state = 'parsing' WHERE id = ?").run(REVISION);
    await expect(service.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION })).rejects.toThrow(/not found|ready/i);
    expect(calls).toBe(0);
  });

  it("does not replace an authoritative snapshot when retrying", async () => {
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    await expect(service.run({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    const task = db.connection.prepare("SELECT id FROM tasks LIMIT 1").get() as { id: string };
    const before = db.connection.prepare("SELECT input_snapshot_json FROM transformation_task_snapshots WHERE task_id = ?").get(task.id) as { input_snapshot_json: string };
    expect(before.input_snapshot_json).toContain("source text");
  });

  it("rolls back the insight when completing the task fails", async () => {
    const tasks = baseDeps.tasks;
    const failingComplete = {
      createTask: tasks.createTask.bind(tasks), start: tasks.start.bind(tasks), advance: tasks.advance.bind(tasks),
      fail: tasks.fail.bind(tasks), retry: tasks.retry.bind(tasks), retryCancelled: tasks.retryCancelled.bind(tasks), cancel: tasks.cancel.bind(tasks),
      complete: () => { throw new Error("complete failed"); }
    };
    const atomic = new TransformationService({ ...baseDeps, tasks: failingComplete });
    await expect(atomic.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION })).rejects.toThrow("complete failed");
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM insights").get()).toEqual({ count: 0 });
    expect(db.connection.prepare("SELECT state FROM tasks").get()).toEqual({ state: "failed" });
  });

  it("supports message and assistant-answer snapshots with project isolation", async () => {
    const conversation = "99999999-9999-4999-8999-999999999999";
    const message = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.connection.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, 'Chat', '2026-01-01', '2026-01-01')").run(conversation, PROJECT);
    db.connection.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, 1, 'assistant', 'answer text', 'completed', '2026-01-01', '2026-01-01')").run(message, conversation);
    const ruleId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    new TransformationRepository(db.connection).create({ id: ruleId, projectId: PROJECT, name: "Answer rule", appliesTo: "answer", prompt: "{{content}}" });
    const insight = await service.run({ projectId: PROJECT, transformationId: ruleId, language: "en", answerMessageId: message });
    expect(insight.inputKind).toBe("answer");
    expect(db.connection.prepare("SELECT rendered_prompt FROM transformation_task_snapshots WHERE task_id = ?").get(insight.taskId)).toMatchObject({ rendered_prompt: expect.stringContaining("answer text") });
    await expect(service.run({ projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", builtinKey: "summary", language: "en", messageId: message })).rejects.toThrow();
  });

  it("runs a custom versioned rule and preserves selected revision order", async () => {
    const ruleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    new TransformationRepository(db.connection).create({ id: ruleId, projectId: PROJECT, name: "Custom", appliesTo: "sources", prompt: "{{source_title}}/{{language}}/{{content}}" });
    const insight = await service.run({ projectId: PROJECT, transformationId: ruleId, language: "zh-CN", sourceRevisionIds: [REVISION, REVISION] });
    expect(insight.transformationId).toBe(ruleId);
    expect(db.connection.prepare("SELECT rule_id, rule_version FROM transformation_task_snapshots WHERE task_id = ?").get(insight.taskId)).toEqual({ rule_id: ruleId, rule_version: 1 });
  });

  it("uses routed fallback and stores the completing profile", async () => {
    const primary = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fallback = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const at = "2026-08-28T00:00:00.000Z";
    for (const [id, model] of [[primary, "primary"], [fallback, "fallback"]]) db.connection.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled, created_at, updated_at) VALUES (?, ?, 'openai', 'generation', 'https://example.test', ?, 1, ?, ?)").run(id, model, model, at, at);
    db.connection.prepare("INSERT INTO model_routes(task_kind, position, profile_id) VALUES ('summary', 0, ?), ('summary', 1, ?)").run(primary, fallback);
    const profiles = new Map([[primary, { id: primary, name: "primary", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId: "primary", enabled: true, createdAt: at, updatedAt: at }], [fallback, { id: fallback, name: "fallback", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId: "fallback", enabled: true, createdAt: at, updatedAt: at }]]);
    const router = new ModelRouter({ getProfile: (id) => profiles.get(id), getRoute: () => [{ taskKind: "summary", position: 0, profileId: primary }, { taskKind: "summary", position: 1, profileId: fallback }] });
    const routed = new RoutedGeneration({ db: db.connection, router, providerFactory: (profile) => ({ discover: async () => [], embed: async () => [[]], generate: async function* () { if (profile.id === primary) throw new ProviderRequestError(classifyProviderError({ status: 503 })); yield { type: "text-delta" as const, text: "fallback result" }; yield { type: "done" as const }; } }), clock: () => new Date(at), id: (() => { let n = 0; return () => `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee${++n}`; })() });
    service = new TransformationService({ ...baseDeps, generation: routed, router });
    const insight = await service.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION });
    expect(insight).toMatchObject({ content: "fallback result", provider: "openai", model: "fallback", profileId: fallback });
    expect(db.connection.prepare("SELECT attempt_order, state FROM model_route_attempts WHERE operation_id = ? ORDER BY attempt_order").all(insight.taskId)).toEqual([{ attempt_order: 0, state: "failed" }, { attempt_order: 1, state: "completed" }]);
  });

  it("resumes a stale running task from its durable snapshot", async () => {
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    const failing = new TransformationService({ ...baseDeps, generation: { generateRouted: async function* () { throw new Error("crash"); } } });
    await expect(failing.run(input)).rejects.toThrow("crash");
    db.connection.prepare("UPDATE tasks SET state = 'running', stage = 'generating', updated_at = '2026-08-20T00:00:00.000Z'").run();
    const repository = new TaskRepository(db.connection, { onTransition: (task) => taskEvents.push(`${task.state}:${task.stage}`) });
    const recoveredTasks = new TaskService(repository, { now: () => "2026-08-28T00:00:00.000Z", random: () => 0, id: () => "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    const resumedService = new TransformationService({ ...baseDeps, tasks: recoveredTasks, taskRepository: repository });
    const resumed = await resumedService.recoverStale(60 * 60 * 1000);
    expect(resumed[0]?.content).toBe("# Result");
    expect(taskEvents).toContain("running:preparing");
    expect(db.connection.prepare("SELECT state FROM tasks").get()).toEqual({ state: "completed" });
  });

  it("preserves custom rule and completing fallback metadata when retrying from a snapshot", async () => {
    const ruleId = "12121212-1212-4121-8121-121212121212";
    const primary = "13131313-1313-4131-8131-131313131313";
    const fallback = "14141414-1414-4141-8141-141414141414";
    const at = "2026-08-28T00:00:00.000Z";
    new TransformationRepository(db.connection).create({ id: ruleId, projectId: PROJECT, name: "Custom retry", appliesTo: "source", prompt: "{{content}}" });
    for (const [id, model] of [[primary, "primary"], [fallback, "fallback"]]) db.connection.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled, created_at, updated_at) VALUES (?, ?, 'openai', 'generation', 'https://example.test', ?, 1, ?, ?)").run(id, model, model, at, at);
    const profile = (id: string, modelId: string) => ({ id, name: modelId, provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId, enabled: true, createdAt: at, updatedAt: at });
    const router = { resolve: () => [profile(primary, "primary"), profile(fallback, "fallback")] };
    let first = true;
    service = new TransformationService({ ...baseDeps, router, generation: { generateRouted: async function* () {
      calls += 1;
      if (first) { first = false; throw new Error("temporary"); }
      yield { type: "text-delta" as const, text: "retried custom" };
      yield { type: "routed-complete" as const, profile: { provider: "openai" as const, model: "fallback", profileId: fallback } };
    } } });
    await expect(service.run({ projectId: PROJECT, transformationId: ruleId, sourceRevisionId: REVISION })).rejects.toThrow("temporary");
    const task = db.connection.prepare("SELECT id FROM tasks").get() as { id: string };
    expect(db.connection.prepare("SELECT transformation_id FROM transformation_task_snapshots WHERE task_id = ?").get(task.id)).toEqual({ transformation_id: ruleId });
    const insight = await service.retry(task.id);
    expect(insight).toMatchObject({ transformationId: ruleId, profileId: fallback, provider: "openai", model: "fallback" });
    expect(db.connection.prepare("SELECT transformation_id, profile_id, provider, model FROM insights WHERE id = ?").get(insight.id)).toEqual({ transformation_id: ruleId, profile_id: fallback, provider: "openai", model: "fallback" });
  });

  it("retry(taskId) starts the queued retry before generating from the old snapshot", async () => {
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    let first = true;
    service = new TransformationService({ ...baseDeps, generation: { generateRouted: async function* () { calls += 1; if (first) { first = false; throw new Error("crash"); } yield* successful("retried"); } } });
    await expect(service.run(input)).rejects.toThrow("crash");
    const task = db.connection.prepare("SELECT id FROM tasks").get() as { id: string };
    const insight = await service.retry(task.id);
    expect(insight.content).toBe("retried");
    expect(taskEvents).toEqual(expect.arrayContaining(["queued:preparing", "running:preparing", "running:generating", "running:saving", "completed:saving"]));
  });

  it("fails a retry before provider use when the persisted route drifts", async () => {
    let drifted = false;
    let first = true;
    const profile = (modelId: string) => ({ id: "router-profile", name: "router", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId, enabled: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const router = { resolve: () => [profile(drifted ? "changed-model" : "router-model")] };
    service = new TransformationService({ ...baseDeps, router, generation: { generateRouted: async function* () { calls += 1; if (first) { first = false; throw new Error("crash"); } yield* successful("must not run"); } } });
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    await expect(service.run(input)).rejects.toThrow("crash");
    const task = db.connection.prepare("SELECT id FROM tasks").get() as { id: string };
    drifted = true;
    await expect(service.retry(task.id)).rejects.toThrow(/validation/i);
    expect(calls).toBe(1);
    expect(db.connection.prepare("SELECT state FROM tasks").get()).toEqual({ state: "failed" });
  });

  it("reports route drift as nonowned before failing and never calls the provider", async () => {
    let drifted = false;
    const profile = (modelId: string) => ({ id: "router-profile", name: "router", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId, enabled: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const router = { resolve: () => [profile(drifted ? "changed-model" : "router-model")] };
    service = new TransformationService({ ...baseDeps, router, generation: { generateRouted: async function* () { calls += 1; throw new Error("provider must not run"); } } });
    const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };
    await expect(service.run(input)).rejects.toThrow("provider must not run");
    const task = db.connection.prepare("SELECT id FROM tasks").get() as { id: string };
    drifted = true;
    const ownership: Array<{ taskId: string; owned: boolean }> = [];
    await expect(service.resume(task.id, undefined, (value) => ownership.push(value))).rejects.toThrow(/validation/i);
    expect(ownership).toEqual([{ taskId: task.id, owned: false }]);
    expect(calls).toBe(1);
  });

  it("returns a completed winner when idempotent task creation races", async () => {
    const winnerTask = "99999999-9999-4999-8999-999999999990";
    const winnerInsight = "99999999-9999-4999-8999-999999999991";
    const tasks = baseDeps.tasks;
    const racingTasks = { ...tasks, createTask: (input: any) => {
      db.connection.prepare("INSERT INTO tasks(id, project_id, source_id, kind, state, stage, progress_1000, idempotency_key) VALUES (?, ?, NULL, 'transformation', 'completed', 'saving', 1000, ?)").run(winnerTask, input.projectId, input.idempotencyKey);
      db.connection.prepare("INSERT INTO insights(id, project_id, task_id, input_kind, input_hash, rule_version, content, idempotency_key) VALUES (?, ?, ?, 'source', 'winner-hash', 1, 'winner insight', ?)").run(winnerInsight, input.projectId, winnerTask, input.idempotencyKey);
      throw new Error("UNIQUE constraint failed: tasks.idempotency_key");
    } };
    const racing = new TransformationService({ ...baseDeps, tasks: racingTasks });
    const insight = await racing.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION });
    expect(insight.content).toBe("winner insight");
    expect(calls).toBe(0);
  });

  it.each(["queued", "running"] as const)("notifies the %s winner before returning from a creation race", async (state) => {
    const winnerTask = state === "queued"
      ? "99999999-9999-4999-8999-999999999980"
      : "99999999-9999-4999-8999-999999999981";
    const callbacks: Array<{ taskId: string; owned: boolean }> = [];
    const tasks = baseDeps.tasks;
    const racingTasks = { ...tasks, createTask: (input: any) => {
      db.connection.prepare("INSERT INTO tasks(id, project_id, source_id, kind, state, stage, progress_1000, idempotency_key) VALUES (?, ?, NULL, 'transformation', ?, 'preparing', 0, ?)").run(winnerTask, input.projectId, state, input.idempotencyKey);
      throw new Error("UNIQUE constraint failed: tasks.idempotency_key");
    } };
    const racing = new TransformationService({ ...baseDeps, tasks: racingTasks });
    await expect(racing.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION }, (ownership) => callbacks.push(ownership)))
      .rejects.toThrow("Transformation already running");
    expect(callbacks).toEqual([{ taskId: winnerTask, owned: false }]);
    expect(baseDeps.taskRepository.findById(winnerTask)?.id).toBe(winnerTask);
    expect(calls).toBe(0);
  });

  it.each(["queued", "running"] as const)("returns the %s winner from startTask after a creation race", (state) => {
    const winnerTask = state === "queued" ? "99999999-9999-4999-8999-999999999970" : "99999999-9999-4999-8999-999999999971";
    const racingTasks = { ...baseDeps.tasks, createTask: (input: any) => {
      db.connection.prepare("INSERT INTO tasks(id, project_id, source_id, kind, state, stage, progress_1000, idempotency_key) VALUES (?, ?, NULL, 'transformation', ?, 'preparing', 0, ?)").run(winnerTask, input.projectId, state, input.idempotencyKey);
      throw new Error("UNIQUE constraint failed: tasks.idempotency_key");
    } };
    const racing = new TransformationService({ ...baseDeps, tasks: racingTasks });
    expect(racing.startTask({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION }).id).toBe(winnerTask);
  });

  it("does not fail the winner when a queued claim loses its CAS race", async () => {
    const winner = baseDeps.tasks;
    const loserTasks = {
      createTask: winner.createTask.bind(winner),
      advance: winner.advance.bind(winner), complete: winner.complete.bind(winner), fail: winner.fail.bind(winner),
      retry: winner.retry.bind(winner), retryCancelled: winner.retryCancelled.bind(winner), cancel: winner.cancel.bind(winner),
      start: (taskId: string, stage: any) => {
        winner.start(taskId, stage);
        throw new StaleTaskStateError(taskId);
      }
    };
    const loser = new TransformationService({ ...baseDeps, tasks: loserTasks });
    await expect(loser.run({ projectId: PROJECT, builtinKey: "summary", language: "en", sourceRevisionId: REVISION }))
      .rejects.toThrow("Transformation already running");
    expect(db.connection.prepare("SELECT state, attempt FROM tasks").get()).toMatchObject({ state: "running", attempt: 0 });
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM insights").get()).toEqual({ count: 0 });
    expect(calls).toBe(0);
  });
});
