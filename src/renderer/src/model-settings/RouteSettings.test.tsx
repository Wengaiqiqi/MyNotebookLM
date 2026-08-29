// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../shared/ipc";
import type { BuiltInModelProfileDto, ModelProfileDto, ModelRouteDto, ModelRouteAttemptDto, ModelTaskKind } from "../../../shared/models";
import RouteSettings from "./RouteSettings";
import { changeLanguage } from "../i18n";

const projectId = "00000000-0000-4000-8000-000000000001";
const generationA = "11111111-1111-4111-8111-111111111111";
const generationB = "22222222-2222-4222-8222-222222222222";
const embedding = "33333333-3333-4333-8333-333333333333";
const embeddingAlt = "55555555-5555-4555-8555-555555555555";
const allTasks: readonly ModelTaskKind[] = ["chat", "note-title", "summary", "key-points", "qa", "custom-transformation", "embedding"];

function profile(id: string, capability: "generation" | "embedding"): ModelProfileDto {
  return {
    id, name: id === generationA ? "Primary" : id === generationB ? "Fallback" : "Embeddings",
    provider: "openai", capability, baseUrl: "https://example.com/v1", modelId: id,
    enabled: true, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z"
  };
}

function route(taskKind: ModelRouteDto["taskKind"], position: number, profileId: string): ModelRouteDto {
  return { taskKind, position, profileId };
}

const builtInProfile: BuiltInModelProfileDto = {
  id: "00000000-0000-4000-8000-000000000001", name: "Built-in embedding", provider: "local", capability: "embedding", baseUrl: "",
  modelId: "Xenova/multilingual-e5-small", enabled: true, dimension: 384, distance: "cosine", pooling: "mean", normalized: true,
  preprocessingVersion: "e5-query-passage-v1", metadata: { dimension: 384, distance: "cosine", pooling: "mean", normalized: true, preprocessingVersion: "e5-query-passage-v1" },
  editable: false, requiresCredential: false
};

const attempts: ModelRouteAttemptDto[] = [{
  id: "44444444-4444-4444-8444-444444444444", projectId, operationId: "op-1", taskKind: "chat",
  attemptOrder: 0, profileId: generationA, provider: "openai", model: "gpt-primary", state: "failed",
  errorCode: "TIMEOUT", latencyMs: 1000, startedAt: "2026-08-25T00:00:00.000Z",
  completedAt: "2026-08-25T00:00:01.000Z", finishedAt: "2026-08-25T00:00:01.000Z", createdAt: "2026-08-25T00:00:00.000Z"
}];

function setup(overrides: Partial<DesktopApi["models"]> = {}) {
  const models: DesktopApi["models"] = {
    listProfiles: vi.fn(), getDefaultRoutes: vi.fn(), setDefaultRoutes: vi.fn(), saveProfile: vi.fn(),
    deleteProfile: vi.fn(), discover: vi.fn(), test: vi.fn(),
    getRoutes: vi.fn().mockResolvedValue({ ok: true, value: [route("chat", 0, generationA)] }),
    saveRoutes: vi.fn().mockResolvedValue({ ok: true, value: [route("chat", 0, generationB), route("chat", 1, generationA)] }),
    listRouteAttempts: vi.fn().mockResolvedValue({ ok: true, value: attempts }),
    ...overrides
  };
  window.myNotebook = { models } as unknown as DesktopApi;
  return models;
}

beforeEach(async () => {
  await changeLanguage("en");
  setup();
});

afterEach(() => cleanup());

describe("RouteSettings", () => {
  it("loads per-task routes, filters profiles by capability, and prevents duplicates", async () => {
    setup({ getRoutes: vi.fn().mockResolvedValue({ ok: true, value: [route("chat", 0, generationA)] }) });
    render(<RouteSettings profiles={[profile(generationA, "generation"), profile(generationB, "generation"), profile(embedding, "embedding")]} projectId={projectId} />);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    expect(screen.getByText("Fallback")).toBeTruthy();
    expect(screen.queryByText("Embeddings")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    expect(screen.getAllByText("Fallback")).toHaveLength(1);
  });

  it("moves fallbacks with accessible commands and saves the ordered route", async () => {
    const models = setup();
    render(<RouteSettings profiles={[profile(generationA, "generation"), profile(generationB, "generation")]} projectId={projectId} />);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    fireEvent.click(screen.getByRole("button", { name: "Move up Fallback" }));
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    await waitFor(() => expect(models.saveRoutes).toHaveBeenCalledWith({ taskKind: "chat", profileIds: [generationB, generationA] }));
  });

  it("enforces one embedding profile and renders fallback history", async () => {
    const models = setup({
      getRoutes: vi.fn().mockResolvedValue({ ok: true, value: [route("embedding", 0, embedding)] }),
      listRouteAttempts: vi.fn().mockResolvedValue({ ok: true, value: [{ ...attempts[0], taskKind: "embedding", profileId: embedding }] })
    });
    render(<RouteSettings profiles={[profile(generationA, "generation"), profile(embedding, "embedding")]} projectId={projectId} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "embedding" } });
    await waitFor(() => expect(screen.getAllByText("Embeddings").length).toBeGreaterThan(0));
    expect(screen.getByText("Embedding uses exactly one profile")).toBeTruthy();
    expect(screen.queryByText(/download|下载/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /download|下载/i })).toBeNull();
    expect(screen.getByText("Fallback history")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add fallback" })).toBeNull();
    expect(screen.getAllByText("Embeddings")).toHaveLength(2);
    expect(models.listRouteAttempts).toHaveBeenCalledWith({ projectId, taskKind: "embedding", limit: 20 });
  });

  it("shows save errors without losing the edited route", async () => {
    const models = setup({ saveRoutes: vi.fn().mockResolvedValue({ ok: false, error: { code: "VALIDATION", messageKey: "errors.modelRouteInconsistent", recoverable: true } }) });
    render(<RouteSettings profiles={[profile(generationA, "generation"), profile(generationB, "generation")]} projectId={projectId} />);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    fireEvent.click(screen.getByRole("button", { name: "Move up Fallback" }));
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Saved model routes are inconsistent");
    await waitFor(() => expect(models.saveRoutes).toHaveBeenCalledWith({ taskKind: "chat", profileIds: [generationB, generationA] }));
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Fallback");
    expect(items[1]?.textContent).toContain("Primary");
  });

  it.each(allTasks)("reads and saves the real route for %s", async (taskKind) => {
    const profileId = taskKind === "embedding" ? embedding : generationA;
    const models = setup({
      getRoutes: vi.fn().mockImplementation(async ({ taskKind: requested }: { taskKind: ModelTaskKind }) => ({ ok: true, value: [route(requested, 0, requested === "embedding" ? embedding : generationA)] })),
      saveRoutes: vi.fn().mockImplementation(async ({ taskKind: requested, profileIds }: { taskKind: ModelTaskKind; profileIds: string[] }) => ({ ok: true, value: [route(requested, 0, profileIds[0]!) ] }))
    });
    render(<RouteSettings profiles={[profile(generationA, "generation"), profile(embedding, "embedding")]} builtInProfiles={[builtInProfile]} projectId={projectId} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: taskKind } });
    await waitFor(() => expect(models.getRoutes).toHaveBeenCalledWith({ taskKind }));
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    await waitFor(() => expect(models.saveRoutes).toHaveBeenCalledWith({ taskKind, profileIds: [profileId] }));
  });

  it("filters disabled and wrong-capability profiles while offering enabled and built-in embeddings", async () => {
    const disabledGeneration = { ...profile(generationB, "generation"), enabled: false };
    const disabledEmbedding = { ...profile(embeddingAlt, "embedding"), enabled: false };
    render(<RouteSettings profiles={[profile(generationA, "generation"), disabledGeneration, profile(embedding, "embedding"), disabledEmbedding]} builtInProfiles={[builtInProfile]} projectId={projectId} />);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    expect(screen.queryByRole("option", { name: "Fallback" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "embedding" } });
    await waitFor(() => expect(screen.getByRole("option", { name: "Built-in embedding" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "Embeddings" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Fallback" })).toBeNull();
  });

  it("replaces an embedding route through the accessible single-profile selector", async () => {
    const models = setup({
      getRoutes: vi.fn().mockResolvedValue({ ok: true, value: [route("embedding", 0, embedding)] }),
      saveRoutes: vi.fn().mockResolvedValue({ ok: true, value: [route("embedding", 0, builtInProfile.id)] })
    });
    render(<RouteSettings profiles={[profile(embedding, "embedding")]} builtInProfiles={[builtInProfile]} projectId={projectId} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "embedding" } });
    const selector = await screen.findByLabelText("Embedding profile");
    fireEvent.change(selector, { target: { value: builtInProfile.id } });
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    await waitFor(() => expect(models.saveRoutes).toHaveBeenCalledWith({ taskKind: "embedding", profileIds: [builtInProfile.id] }));
  });

  it("offers a repair action when a route is empty", async () => {
    setup({ getRoutes: vi.fn().mockResolvedValue({ ok: true, value: [] }) });
    render(<RouteSettings profiles={[profile(generationA, "generation")]} projectId={projectId} />);
    await waitFor(() => expect(screen.getByText("No model route configured")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Add first profile" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders attempt details and refreshes history when the task changes", async () => {
    const summaryAttempt = { ...attempts[0], taskKind: "summary" as const, model: "summary-model", state: "completed" as const, errorCode: null };
    const listRouteAttempts = vi.fn().mockImplementation(async ({ taskKind: requested }: { taskKind: ModelTaskKind }) => ({ ok: true, value: [requested === "summary" ? summaryAttempt : attempts[0]] }));
    const models = setup({ listRouteAttempts });
    render(<RouteSettings profiles={[profile(generationA, "generation")]} projectId={projectId} />);
    await waitFor(() => expect(screen.getByText("openai · gpt-primary")).toBeTruthy());
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("TIMEOUT")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "summary" } });
    await waitFor(() => expect(models.listRouteAttempts).toHaveBeenCalledWith({ projectId, taskKind: "summary", limit: 20 }));
    await waitFor(() => expect(screen.getByText("openai · summary-model")).toBeTruthy());
    expect(screen.getByText("Completed")).toBeTruthy();
  });
});
