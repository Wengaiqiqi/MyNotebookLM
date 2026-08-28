import { describe, expect, it } from "vitest";
import { appErrorDtoSchema } from "./app-errors";
import { modelProfileInputSchema, modelRouteAttemptDtoSchema, modelRouteDtoSchema } from "./models";
import { createTransformationInputSchema, insightDtoSchema } from "./transformations";
import { appSettingsDtoSchema } from "./settings";
import { sourceDtoSchema, sourceLocatorSchema } from "./sources";
import { citationLocatorSchema } from "./chat";
import { taskDtoSchema } from "./tasks";
import { listNotesInputSchema } from "./notes";

describe("shared DTO schemas", () => {
  it("accepts only exact transformation placeholders", () => {
    const base = { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Rule", appliesTo: "note" as const };
    for (const prompt of ["Use {{content}} from {{source_title}}", "{{project_name}} / {{language}}"])
      expect(createTransformationInputSchema.safeParse({ ...base, prompt }).success).toBe(true);
    for (const prompt of ["{{unknown}}", "{{ content }}", "{{#if content}}{{content}}{{/if}}", "${content}", "<% content %>", "{% if content %}", "{{content"])
      expect(createTransformationInputSchema.safeParse({ ...base, prompt }).success).toBe(false);
  });

  it("requires an operation id for route attempts", () => {
    expect(modelRouteAttemptDtoSchema.safeParse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      operationId: null, taskKind: "summary", attemptOrder: 0, profileId: null, provider: "openai", model: "model",
      state: "started", errorCode: null, latencyMs: null, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null,
      finishedAt: null, createdAt: "2026-01-01T00:00:00.000Z"
    }).success).toBe(false);
  });

  it("rejects insight DTO models longer than 200 characters", () => {
    expect(insightDtoSchema.safeParse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      transformationId: null, taskId: null, inputKind: null, inputHash: null, ruleVersion: null, content: "result",
      provider: "openai", model: "x".repeat(201), profileId: null, usage: null, idempotencyKey: "key",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }).success).toBe(false);
  });
  it("rejects unknown model fields", () => {
    expect(() => modelProfileInputSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Primary",
      provider: "openai",
      capability: "generation",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
      enabled: true,
      unexpected: true
    })).toThrow();
    expect(() => modelRouteDtoSchema.parse({
      taskKind: "chat",
      position: 0,
      profileId: "11111111-1111-4111-8111-111111111111",
      unexpected: true
    })).toThrow();
  });

  it("rejects unknown settings fields", () => {
    expect(() => appSettingsDtoSchema.parse({
      onboardingCompleted: false,
      locale: "zh-CN",
      theme: "light",
      unexpected: true
    })).toThrow();
  });

  it("rejects unknown app error fields", () => {
    expect(() => appErrorDtoSchema.parse({
      code: "INTERNAL",
      messageKey: "errors.internal",
      recoverable: false,
      unexpected: true
    })).toThrow();
  });

  it("rejects unknown source and task fields", () => {
    expect(() => sourceDtoSchema.parse({
      id: "99999999-9999-4999-8999-999999999991",
      projectId: "11111111-1111-4111-8111-111111111111",
      kind: "pdf",
      displayName: "Doc",
      status: "active",
      currentRevisionId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      unexpected: true
    })).toThrow();
    expect(() => taskDtoSchema.parse({
      id: "77777777-7777-4777-8777-777777777771",
      projectId: "11111111-1111-4111-8111-111111111111",
      sourceId: null,
      kind: "ingest",
      state: "queued",
      stage: "validating",
      progress: 0,
      attempt: 0,
      error: null,
      idempotencyKey: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      unexpected: true
    })).toThrow();
  });

  it("rejects unknown note list fields", () => {
    expect(() => listNotesInputSchema.parse({ projectId: "11111111-1111-4111-8111-111111111111", unexpected: true })).toThrow();
  });

  it("validates normalized source locators", () => {
    expect(sourceLocatorSchema.parse({
      kind: "page",
      page: 3
    })).toEqual({ kind: "page", page: 3 });
    expect(() => sourceLocatorSchema.parse({
      kind: "row",
      sheet: "Sheet1",
      startRow: 5,
      endRow: 2
    })).toThrow();
    expect(() => sourceLocatorSchema.parse({
      kind: "page",
      page: 0
    })).toThrow();
    expect(() => sourceLocatorSchema.parse({
      kind: "page",
      page: 3,
      endPage: 2
    })).toThrow();
    expect(() => sourceLocatorSchema.parse({
      kind: "slide",
      slide: 4,
      endSlide: 3
    })).toThrow();
    expect(() => sourceLocatorSchema.parse({
      kind: "paragraph",
      paragraph: 2,
      endParagraph: 1
    })).toThrow();
  });

  it("accepts persisted source-chunk locators as citation locators", () => {
    // Real PDF citations reuse the chunk locator verbatim, including multi-page spans.
    expect(citationLocatorSchema.parse({ kind: "page", page: 1, endPage: 2 })).toEqual({ kind: "page", page: 1, endPage: 2 });
    expect(citationLocatorSchema.parse({ kind: "page", page: 3 })).toEqual({ kind: "page", page: 3 });
    expect(citationLocatorSchema.parse({ kind: "heading", depth: 1, headingPath: "第二章" })).toEqual({ kind: "heading", depth: 1, headingPath: "第二章" });
    expect(citationLocatorSchema.parse({ kind: "row", sheet: "Sheet1", startRow: 1, endRow: 3 })).toEqual({ kind: "row", sheet: "Sheet1", startRow: 1, endRow: 3 });
    expect(() => citationLocatorSchema.parse({ kind: "page", page: 0 })).toThrow();
    expect(() => citationLocatorSchema.parse({ kind: "page", page: 3, endPage: 2 })).toThrow();
    expect(() => citationLocatorSchema.parse({ unexpected: true })).toThrow();
  });
});
