import { describe, expect, it } from "vitest";
import { appErrorDtoSchema } from "./app-errors";
import { modelProfileInputSchema, modelRouteDtoSchema } from "./models";
import { appSettingsDtoSchema } from "./settings";
import { sourceDtoSchema, sourceLocatorSchema } from "./sources";
import { taskDtoSchema } from "./tasks";

describe("shared DTO schemas", () => {
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
});
