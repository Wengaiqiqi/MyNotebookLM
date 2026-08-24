import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto } from "../../shared/projects";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ProjectRepository } from "./project-repository";
import { ProjectService } from "./project-service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const malformedProject = {
  id: "not-a-uuid",
  name: "AI 研究",
  archived: false,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
} as ProjectDto;

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
    vi.restoreAllMocks();
    appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("trims names and rejects invalid create input before repository access", () => {
    const service = new ProjectService(repository, () => PROJECT_ID);
    const create = vi.spyOn(repository, "create");

    expect(service.create({ name: "  AI 研究  " }).name).toBe("AI 研究");
    create.mockClear();

    expect(() =>
      new ProjectService(repository, () => SECOND_PROJECT_ID).create({ name: "   " })
    ).toThrow();
    expect(() =>
      new ProjectService(repository, () => THIRD_PROJECT_ID).create({
        name: "x".repeat(81)
      })
    ).toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects invalid mutation input before repository access", () => {
    const service = new ProjectService(repository, () => PROJECT_ID);
    const rename = vi.spyOn(repository, "rename");
    const archive = vi.spyOn(repository, "archive");
    const remove = vi.spyOn(repository, "remove");

    expect(() => service.rename({ id: "not-a-uuid", name: "RAG 研究" })).toThrow();
    expect(() => service.rename({ id: PROJECT_ID, name: "   " })).toThrow();
    expect(() => service.archive({ id: "not-a-uuid" })).toThrow();
    expect(() => service.remove({ id: "not-a-uuid" })).toThrow();

    expect(rename).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects malformed repository list output", () => {
    vi.spyOn(repository, "list").mockReturnValue([malformedProject]);

    expect(() => new ProjectService(repository).list()).toThrow();
  });

  it("rejects malformed repository create output", () => {
    vi.spyOn(repository, "create").mockReturnValue(malformedProject);

    expect(() =>
      new ProjectService(repository, () => PROJECT_ID).create({ name: "AI 研究" })
    ).toThrow();
  });

  it("rejects malformed repository rename output", () => {
    vi.spyOn(repository, "rename").mockReturnValue(malformedProject);

    expect(() =>
      new ProjectService(repository).rename({ id: PROJECT_ID, name: "RAG 研究" })
    ).toThrow();
  });

  it("rejects malformed repository archive output", () => {
    vi.spyOn(repository, "archive").mockReturnValue(malformedProject);

    expect(() => new ProjectService(repository).archive({ id: PROJECT_ID })).toThrow();
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
