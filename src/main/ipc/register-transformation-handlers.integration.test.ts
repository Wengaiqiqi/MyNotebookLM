import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcMain } from "electron";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { TRANSFORMATION_CHANNELS } from "../../shared/ipc";
import { TaskRepository } from "../tasks/task-repository";
import { TaskService } from "../tasks/task-service";
import { NoteRepository } from "../notes/note-repository";
import { TransformationRepository } from "../notes/transformation-repository";
import { TransformationService } from "../notes/transformation-service";
import { registerTransformationHandlers } from "./register-transformation-handlers";

type Handler = Parameters<IpcMain["handle"]>[1];
class FakeIpc implements Pick<IpcMain, "handle" | "removeHandler"> {
  handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler) { this.handlers.set(channel, handler); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const CHUNK = "44444444-4444-4444-8444-444444444444";
const input = { projectId: PROJECT, builtinKey: "summary" as const, language: "en" as const, sourceRevisionId: REVISION };

const invoke = (ipc: FakeIpc, channel: string, value: unknown) => ipc.handlers.get(channel)!({} as never, value);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("transformation ownership IPC integration", () => {
  let root: string;
  let db: AppDatabase;
  afterEach(() => { db?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  function setup(generation: { generateRouted: (...args: any[]) => AsyncGenerator<any> }) {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-transformation-ipc-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    db.connection.prepare("INSERT INTO projects(id, name) VALUES (?, 'Research')").run(PROJECT);
    db.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', 'Source', 'active')").run(SOURCE, PROJECT);
    db.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, 'a.txt', 'a.txt', 'hash', 'offset', 'v1', 'ready')").run(REVISION, SOURCE);
    db.connection.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(REVISION, SOURCE);
    db.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, 0, 'source text', '{}', 'chunk-hash')").run(CHUNK, REVISION);
    const repository = new TaskRepository(db.connection);
    const tasks = new TaskService(repository, { now: () => "2026-08-28T00:00:00.000Z", random: () => 0, id: randomUUID });
    const profile = { id: "router-profile", name: "router", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId: "router-model", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const service = new TransformationService({
      db: db.connection, tasks, taskRepository: repository, transformations: new TransformationRepository(db.connection), notes: new NoteRepository(db.connection), generation,
      router: { resolve: () => [profile] }, id: randomUUID
    });
    const ipc = new FakeIpc();
    return { ipc, cleanup: registerTransformationHandlers(ipc, service), service };
  }

  it("uses one real owner, rejects a second runner, and cancels only the owner", async () => {
    let calls = 0; let captured!: AbortSignal; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { ipc, cleanup } = setup({ generateRouted: async function* (_kind, _request, _profile, signal) {
      calls += 1; captured = signal; await gate; if (signal.aborted) throw new Error("aborted"); yield { type: "text-delta", text: "result" }; yield { type: "done" }; yield { type: "routed-complete", profile: { provider: "openai", model: "router-model", profileId: null } };
    } });
    const first = await invoke(ipc, TRANSFORMATION_CHANNELS.run, input) as any;
    for (let i = 0; i < 10 && !captured; i += 1) await tick();
    expect(first.ok).toBe(true); expect(calls).toBe(1); expect(captured).toBeInstanceOf(AbortSignal);
    const second = await invoke(ipc, TRANSFORMATION_CHANNELS.run, input) as any;
    expect(second).toMatchObject({ ok: true, value: { id: first.value.id, state: "running" } });
    await expect(invoke(ipc, TRANSFORMATION_CHANNELS.cancel, { projectId: PROJECT, taskId: first.value.id })).resolves.toMatchObject({ ok: true, value: { state: "cancelled" } });
    expect(captured.aborted).toBe(true); release(); await tick();
    expect(db.connection.prepare("SELECT state FROM tasks WHERE id = ?").get(first.value.id)).toEqual({ state: "cancelled" });
    cleanup();
  });

  it("reuses completed work without another provider call or leaked controller", async () => {
    let calls = 0; let captured!: AbortSignal;
    const { ipc, cleanup } = setup({ generateRouted: async function* (_kind, _request, _profile, signal) {
      calls += 1; captured = signal; yield { type: "text-delta", text: "result" }; yield { type: "done" }; yield { type: "routed-complete", profile: { provider: "openai", model: "router-model", profileId: null } };
    } });
    const first = await invoke(ipc, TRANSFORMATION_CHANNELS.run, input) as any;
    for (let i = 0; i < 10; i += 1) { await tick(); if ((db.connection.prepare("SELECT state FROM tasks WHERE id = ?").get(first.value.id) as { state?: string } | undefined)?.state === "completed") break; }
    const reused = await invoke(ipc, TRANSFORMATION_CHANNELS.run, input) as any;
    expect(reused).toMatchObject({ ok: true, value: { id: first.value.id } }); expect(calls).toBe(1);
    cleanup(); expect(captured.aborted).toBe(false);
  });
});
