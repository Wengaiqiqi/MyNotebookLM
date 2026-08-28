import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import {
  TransformationNotFoundError,
  TransformationVersionConflictError,
  TransformationRepository
} from "./transformation-repository";

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RULE = "11111111-1111-4111-8111-111111111111";

describe("TransformationRepository", () => {
  let root: string;
  let db: AppDatabase;
  let repository: TransformationRepository;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-transformations-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    repository = new TransformationRepository(db.connection);
    db.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?), (?, ?)")
      .run(PROJECT_A, "A", PROJECT_B, "B");
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates enabled version-one rules and lists only the requested project", () => {
    const created = repository.create({
      id: RULE,
      projectId: PROJECT_A,
      name: "Summarize",
      appliesTo: "source",
      prompt: "Summarize {{content}}"
    });

    expect(created).toMatchObject({
      id: RULE,
      projectId: PROJECT_A,
      name: "Summarize",
      appliesTo: "source",
      prompt: "Summarize {{content}}",
      version: 1,
      enabled: true
    });
    expect(repository.list(PROJECT_A)).toEqual([created]);
    expect(repository.list(PROJECT_B)).toEqual([]);
    expect(repository.get(PROJECT_B, RULE)).toBeUndefined();
  });

  it("increments version for semantic edits, including enabled state", () => {
    repository.create({ id: RULE, projectId: PROJECT_A, name: "Rule", appliesTo: "source", prompt: "{{content}}" });
    const edited = repository.update({
      id: RULE,
      projectId: PROJECT_A,
      name: "Renamed",
      appliesTo: "sources",
      prompt: "Use {{content}}",
      enabled: false,
      version: 1
    });
    expect(edited).toMatchObject({ name: "Renamed", appliesTo: "sources", prompt: "Use {{content}}", enabled: false, version: 2 });
  });

  it("returns an exact no-op without bumping the version", () => {
    const created = repository.create({ id: RULE, projectId: PROJECT_A, name: "Rule", appliesTo: "source", prompt: "{{content}}" });
    const unchanged = repository.update({
      id: RULE,
      projectId: PROJECT_A,
      name: created.name,
      appliesTo: created.appliesTo,
      prompt: created.prompt,
      enabled: created.enabled,
      version: created.version
    });
    expect(unchanged).toEqual(created);
  });

  it("checks the expected version before no-op comparison", () => {
    repository.create({ id: RULE, projectId: PROJECT_A, name: "Rule", appliesTo: "source", prompt: "{{content}}" });
    expect(() => repository.update({
      id: RULE,
      projectId: PROJECT_A,
      name: "Rule",
      appliesTo: "source",
      prompt: "{{content}}",
      enabled: true,
      version: 2
    })).toThrow(TransformationVersionConflictError);
  });

  it("keeps not-found and cross-project failures stable and deletes with CAS", () => {
    repository.create({ id: RULE, projectId: PROJECT_A, name: "Rule", appliesTo: "source", prompt: "{{content}}" });
    expect(() => repository.update({ id: RULE, projectId: PROJECT_B, name: "Rule", appliesTo: "source", prompt: "{{content}}", enabled: true, version: 1 }))
      .toThrow(TransformationNotFoundError);
    expect(() => repository.remove(PROJECT_B, RULE, 1)).toThrow(TransformationNotFoundError);
    expect(() => repository.remove(PROJECT_A, RULE, 2)).toThrow(TransformationVersionConflictError);
    expect(() => repository.remove(PROJECT_A, RULE, 1)).not.toThrow();
    expect(repository.get(PROJECT_A, RULE)).toBeUndefined();
    expect(repository.list(PROJECT_A)).toEqual([]);
  });

  it("rejects invalid prompts through the shared schema", () => {
    expect(() => repository.create({
      id: RULE,
      projectId: PROJECT_A,
      name: "Unsafe",
      appliesTo: "source",
      prompt: "{{unknown}}"
    })).toThrow();
  });
});
