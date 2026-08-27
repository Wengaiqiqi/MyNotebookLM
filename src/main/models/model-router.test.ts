import { describe, expect, it } from "vitest";
import type { ModelProfileDto, ModelRouteDto, ModelTaskKind } from "../../shared/models";
import { ModelRouter } from "./model-router";

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const EMBEDDING_ID = "33333333-3333-4333-8333-333333333333";
const INACTIVE_ID = "44444444-4444-4444-8444-444444444444";
const MISMATCH_ID = "55555555-5555-4555-8555-555555555555";
const MISSING_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_EMBEDDING_ID = "77777777-7777-4777-8777-777777777777";
const INACTIVE_EMBEDDING_ID = "88888888-8888-4888-8888-888888888888";

function profile(id: string, capability: "generation" | "embedding", enabled = true): ModelProfileDto {
  return {
    id,
    name: id,
    provider: "openai",
    capability,
    baseUrl: "https://api.openai.com/v1",
    modelId: id,
    enabled,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  };
}

class FakeRoutes {
  readonly profiles = new Map<string, ModelProfileDto>([
    [PRIMARY_ID, profile(PRIMARY_ID, "generation")],
    [FALLBACK_ID, profile(FALLBACK_ID, "generation")],
    [EMBEDDING_ID, profile(EMBEDDING_ID, "embedding")],
    [SECOND_EMBEDDING_ID, profile(SECOND_EMBEDDING_ID, "embedding")],
    [INACTIVE_EMBEDDING_ID, profile(INACTIVE_EMBEDDING_ID, "embedding", false)],
    [INACTIVE_ID, profile(INACTIVE_ID, "generation", false)],
    [MISMATCH_ID, profile(MISMATCH_ID, "embedding")]
  ]);
  readonly routes = new Map<ModelTaskKind, ModelRouteDto[]>([
    ["chat", [
      { taskKind: "chat", position: 0, profileId: INACTIVE_ID },
      { taskKind: "chat", position: 1, profileId: FALLBACK_ID },
      { taskKind: "chat", position: 2, profileId: FALLBACK_ID },
      { taskKind: "chat", position: 3, profileId: MISSING_ID },
      { taskKind: "chat", position: 4, profileId: MISMATCH_ID },
      { taskKind: "chat", position: 5, profileId: PRIMARY_ID }
    ]],
    ["embedding", [
      { taskKind: "embedding", position: 0, profileId: EMBEDDING_ID },
      { taskKind: "embedding", position: 1, profileId: SECOND_EMBEDDING_ID }
    ]]
  ]);

  getProfile(id: string): ModelProfileDto | undefined {
    return this.profiles.get(id);
  }

  getRoute(taskKind: ModelTaskKind): ModelRouteDto[] {
    return this.routes.get(taskKind) ?? [];
  }
}

describe("ModelRouter", () => {
  it("puts an eligible explicit override first and then ordered unique fallbacks", () => {
    const routes = new FakeRoutes();
    const resolved = new ModelRouter(routes).resolve("chat", PRIMARY_ID);

    expect(resolved.map((item) => item.id)).toEqual([PRIMARY_ID, FALLBACK_ID]);
  });

  it("skips inactive, missing and capability-mismatched profiles", () => {
    const routes = new FakeRoutes();
    expect(new ModelRouter(routes).resolve("chat").map((item) => item.id)).toEqual([
      FALLBACK_ID,
      PRIMARY_ID
    ]);
  });

  it("returns one embedding profile and no fallback, or a stable empty route", () => {
    const routes = new FakeRoutes();
    expect(new ModelRouter(routes).resolve("embedding").map((item) => item.id)).toEqual([EMBEDDING_ID]);
    expect(new ModelRouter(new FakeRoutes()).resolve("summary")).toEqual([]);
  });

  it.each([
    ["inactive", INACTIVE_EMBEDDING_ID],
    ["missing", MISSING_ID]
  ])("does not fallback to a second embedding route when the first is %s", (_label, firstProfileId) => {
    const routes = new FakeRoutes();
    routes.routes.set("embedding", [
      { taskKind: "embedding", position: 0, profileId: firstProfileId },
      { taskKind: "embedding", position: 1, profileId: SECOND_EMBEDDING_ID }
    ]);

    expect(new ModelRouter(routes).resolve("embedding")).toEqual([]);
  });

  it("does not fallback to the configured embedding route when an explicit override is invalid", () => {
    const routes = new FakeRoutes();

    expect(new ModelRouter(routes).resolve("embedding", INACTIVE_ID)).toEqual([]);
  });

  it("returns snapshots unaffected by later repository profile mutation", () => {
    const routes = new FakeRoutes();
    const resolved = new ModelRouter(routes).resolve("chat");
    const original = resolved[0]!;
    routes.profiles.get(FALLBACK_ID)!.name = "mutated";

    expect(original.name).toBe(FALLBACK_ID);
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => {
      (original as { name: string }).name = "changed";
    }).toThrow();
  });
});
