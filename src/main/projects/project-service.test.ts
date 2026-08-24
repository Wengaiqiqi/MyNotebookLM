import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ProjectRepository } from "./project-repository";
import { ProjectService } from "./project-service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("ProjectService", () => {
  let temporaryRoot: string;
  let appDatabase: AppDatabase;
  let repository: ProjectRepository;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-project-service-"));
    appDatabase = openAppDatabase(
      path.join(temporaryRoot, "app.db"),
      path.resolve("src/main/db/migrations")
    );
    repository = new ProjectRepository(appDatabase.connection);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("trims names and rejects invalid create input", () => {
    const service = new ProjectService(repository, () => PROJECT_ID);

    expect(service.create({ name: "  AI 研究  " }).name).toBe("AI 研究");
    expect(() => service.create({ name: "   " })).toThrow();
    expect(() => service.create({ name: "x".repeat(81) })).toThrow();
  });

  it("lists, renames, archives, and removes projects", () => {
    const service = new ProjectService(repository, () => PROJECT_ID);
    const created = service.create({ name: "AI 研究" });

    expect(service.list()).toEqual([created]);
    expect(service.rename({ id: PROJECT_ID, name: "  RAG 研究  " }).name).toBe(
      "RAG 研究"
    );
    expect(service.archive({ id: PROJECT_ID }).archived).toBe(true);
    expect(service.list()).toEqual([]);

    service.remove({ id: PROJECT_ID });
    expect(repository.list({ includeArchived: true })).toEqual([]);
  });
});
