import { describe, expect, it } from "vitest";
import { appErrorDtoSchema } from "./app-errors";
import { modelProfileInputSchema, modelRouteDtoSchema } from "./models";
import { appSettingsDtoSchema } from "./settings";

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
});
