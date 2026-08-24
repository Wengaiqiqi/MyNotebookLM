import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ProjectNotFoundError, ProjectRepository } from "./project-repository";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("ProjectRepository", () => {
  let temporaryRoot: string;
  let appDatabase: AppDatabase;
  let repository: ProjectRepository;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-projects-"));
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

  it("creates, renames, archives, and removes a project", () => {
    const created = repository.create({ id: PROJECT_ID, name: "AI 研究" });
    expect(repository.list()).toEqual([created]);

    const renamed = repository.rename(PROJECT_ID, "RAG 研究");
    expect(renamed.name).toBe("RAG 研究");

    expect(repository.archive(PROJECT_ID).archived).toBe(true);
    expect(repository.list()).toEqual([]);
    expect(repository.list({ includeArchived: true })).toHaveLength(1);

    repository.remove(PROJECT_ID);
    expect(repository.list({ includeArchived: true })).toEqual([]);
  });

  it.each([
    ["rename", () => repository.rename(UNKNOWN_PROJECT_ID, "Unknown")],
    ["archive", () => repository.archive(UNKNOWN_PROJECT_ID)],
    ["remove", () => repository.remove(UNKNOWN_PROJECT_ID)]
  ])("throws ProjectNotFoundError when %s targets an unknown UUID", (_, action) => {
    expect(action).toThrow(ProjectNotFoundError);
  });
});
