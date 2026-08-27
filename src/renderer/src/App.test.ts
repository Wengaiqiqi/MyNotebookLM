// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../shared/ipc";
import type { BuiltInModelProfileDto } from "../../shared/models";
import type { ProjectDto } from "../../shared/projects";
import App from "./App";
import { changeLanguage, changeTheme } from "./i18n";

const styles = readFileSync("src/renderer/src/styles.css", "utf8");

const projectA: ProjectDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "First project",
  archived: false,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
};

const projectB: ProjectDto = {
  ...projectA,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Authoritative project",
  updatedAt: "2026-08-24T01:00:00.000Z"
};

const builtInEmbedding: BuiltInModelProfileDto = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Multilingual E5 Small",
  provider: "local",
  capability: "embedding",
  baseUrl: "",
  modelId: "Xenova/multilingual-e5-small",
  enabled: true,
  dimension: 384,
  distance: "cosine",
  pooling: "mean",
  normalized: true,
  preprocessingVersion: "e5-query-passage-v1",
  metadata: {
    dimension: 384,
    distance: "cosine",
    pooling: "mean",
    normalized: true,
    preprocessingVersion: "e5-query-passage-v1"
  },
  editable: false,
  requiresCredential: false
};

type ApiDouble = {
  api: DesktopApi;
  list: ReturnType<typeof vi.fn<DesktopApi["projects"]["list"]>>;
  create: ReturnType<typeof vi.fn<DesktopApi["projects"]["create"]>>;
  rename: ReturnType<typeof vi.fn<DesktopApi["projects"]["rename"]>>;
  archive: ReturnType<typeof vi.fn<DesktopApi["projects"]["archive"]>>;
  setTitleOverlayTheme: ReturnType<typeof vi.fn<DesktopApi["titleOverlay"]["setTheme"]>>;
  getSettings: ReturnType<typeof vi.fn<DesktopApi["settings"]["get"]>>;
  updateSettings: ReturnType<typeof vi.fn<DesktopApi["settings"]["update"]>>;
  listProfiles: ReturnType<typeof vi.fn<DesktopApi["models"]["listProfiles"]>>;
  getDefaultRoutes: ReturnType<typeof vi.fn<DesktopApi["models"]["getDefaultRoutes"]>>;
  setDefaultRoutes: ReturnType<typeof vi.fn<DesktopApi["models"]["setDefaultRoutes"]>>;
  saveProfile: ReturnType<typeof vi.fn<DesktopApi["models"]["saveProfile"]>>;
  testModel: ReturnType<typeof vi.fn<DesktopApi["models"]["test"]>>;
};

const roots: Root[] = [];

function createApi(projects: ProjectDto[] = [], onboardingCompleted = true): ApiDouble {
  const list = vi.fn<DesktopApi["projects"]["list"]>().mockResolvedValue(projects);
  const create = vi.fn<DesktopApi["projects"]["create"]>().mockResolvedValue(projectA);
  const rename = vi.fn<DesktopApi["projects"]["rename"]>().mockResolvedValue(projectA);
  const archive = vi.fn<DesktopApi["projects"]["archive"]>().mockResolvedValue(projectA);
  const setTitleOverlayTheme = vi.fn<DesktopApi["titleOverlay"]["setTheme"]>().mockResolvedValue({
    ok: true,
    value: undefined
  });
  const getSettings = vi.fn<DesktopApi["settings"]["get"]>().mockResolvedValue({
    ok: true,
    value: { onboardingCompleted, locale: "en", theme: "light" }
  });
  const updateSettings = vi.fn<DesktopApi["settings"]["update"]>().mockImplementation(async (input) => ({
    ok: true,
    value: {
      onboardingCompleted: input.onboardingCompleted ?? onboardingCompleted,
      locale: input.locale ?? "en",
      theme: input.theme ?? "light"
    }
  }));
  const listProfiles = vi.fn<DesktopApi["models"]["listProfiles"]>().mockResolvedValue({
    ok: true,
    value: { profiles: [], builtInProfiles: [], credentials: [] }
  });
  const getDefaultRoutes = vi.fn<DesktopApi["models"]["getDefaultRoutes"]>().mockResolvedValue({
    ok: true,
    value: onboardingCompleted
      ? { generationProfileId: projectA.id, embeddingProfileId: projectB.id }
      : {}
  });
  const setDefaultRoutes = vi.fn<DesktopApi["models"]["setDefaultRoutes"]>().mockImplementation(async (input) => ({
    ok: true,
    value: input
  }));
  const saveProfile = vi.fn<DesktopApi["models"]["saveProfile"]>().mockImplementation(async ({ profile }) => ({
    ok: true,
    value: {
      ...profile,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z"
    }
  }));
  const testModel = vi.fn<DesktopApi["models"]["test"]>().mockImplementation(async ({ profile }) => ({
    ok: true,
    value: { modelId: profile.modelId, capability: profile.capability, verifiedBy: "probe" }
  }));
  return {
    list,
    create,
    rename,
    archive,
    setTitleOverlayTheme,
    getSettings,
    updateSettings,
    listProfiles,
    getDefaultRoutes,
    setDefaultRoutes,
    saveProfile,
    testModel,
    api: {
      projects: {
        list,
        create,
        rename,
        archive,
        remove: vi.fn<DesktopApi["projects"]["remove"]>().mockResolvedValue(undefined)
      },
      settings: {
        get: getSettings,
        update: updateSettings
      },
      models: {
        listProfiles,
        getDefaultRoutes,
        setDefaultRoutes,
        saveProfile,
        deleteProfile: vi.fn<DesktopApi["models"]["deleteProfile"]>(),
        discover: vi.fn<DesktopApi["models"]["discover"]>().mockResolvedValue({
          ok: true,
          value: []
        }),
        test: testModel
      },
      credentials: {
        set: vi.fn<DesktopApi["credentials"]["set"]>(),
        remove: vi.fn<DesktopApi["credentials"]["remove"]>()
      },
      titleOverlay: {
        setTheme: setTitleOverlayTheme
      },
      vector: {
        getHealth: vi.fn<DesktopApi["vector"]["getHealth"]>(),
        startMigration: vi.fn<DesktopApi["vector"]["startMigration"]>(),
        rebuild: vi.fn<DesktopApi["vector"]["rebuild"]>(),
        optimize: vi.fn<DesktopApi["vector"]["optimize"]>(),
        cancelTask: vi.fn<DesktopApi["vector"]["cancelTask"]>(),
        subscribe: vi.fn<DesktopApi["vector"]["subscribe"]>(() => () => undefined)
      },
      retrieval: {
        search: vi.fn<DesktopApi["retrieval"]["search"]>()
      },
      conversations: {
        list: vi.fn<DesktopApi["conversations"]["list"]>(),
        create: vi.fn<DesktopApi["conversations"]["create"]>(),
        rename: vi.fn<DesktopApi["conversations"]["rename"]>(),
        archive: vi.fn<DesktopApi["conversations"]["archive"]>(),
        delete: vi.fn<DesktopApi["conversations"]["delete"]>(),
        listMessages: vi.fn<DesktopApi["conversations"]["listMessages"]>()
      },
      chat: {
        send: vi.fn<DesktopApi["chat"]["send"]>(),
        stop: vi.fn<DesktopApi["chat"]["stop"]>(),
        regenerate: vi.fn<DesktopApi["chat"]["regenerate"]>(),
        subscribe: vi.fn<DesktopApi["chat"]["subscribe"]>(() => () => undefined),
        unsubscribe: vi.fn<DesktopApi["chat"]["unsubscribe"]>()
      },
      citations: {
        open: vi.fn<DesktopApi["citations"]["open"]>()
      }
    }
  };
}

async function renderApp(api: DesktopApi): Promise<HTMLElement> {
  window.myNotebook = api;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(App)));
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

function button(container: ParentNode, name: string): HTMLButtonElement {
  const candidates = [...container.querySelectorAll("button")];
  if (container !== document) candidates.push(...document.querySelectorAll("button"));
  const match = candidates.find(
    (candidate) => {
      const text = candidate.textContent?.trim();
      return text === name || text?.endsWith(name);
    }
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return match;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function enterProjectName(container: HTMLElement, name: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#project-name")
    ?? document.querySelector<HTMLInputElement>("#project-name");
  if (!input) throw new Error("Missing project name input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function labelledField<T extends HTMLInputElement | HTMLSelectElement>(
  container: ParentNode,
  label: string
): T {
  const element = [...container.querySelectorAll<T>("input, select")]
    .find((candidate) => candidate.labels?.[0]?.firstChild?.textContent?.trim() === label);
  if (!element) throw new Error(`Missing field: ${label}`);
  return element;
}

async function setField(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  document.head.innerHTML = `<style>${styles}</style>`;
  localStorage.clear();
  await changeLanguage("en");
  changeTheme("light");
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
});

describe("App shell behavior", () => {
  it("gates project loading on persisted onboarding and opens first launch for a fresh profile", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopApi["settings"]["get"]>>>();
    const { api, getSettings, list } = createApi([], false);
    getSettings.mockReturnValueOnce(pending.promise);

    const container = await renderApp(api);
    expect(list).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Start a new research project");

    await act(async () => {
      pending.resolve({
        ok: true,
        value: { onboardingCompleted: false, locale: "en", theme: "light" }
      });
      await pending.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Welcome to MyNotebookLM");
    expect(container.textContent).not.toContain("Start a new research project");
    expect(list).not.toHaveBeenCalled();
  });

  it("offers a no-drag theme control in the first-launch header", async () => {
    const { api, updateSettings } = createApi([], false);
    const container = await renderApp(api);
    const toggle = container.querySelector<HTMLElement>(".onboarding-theme-toggle");

    expect(toggle?.classList.contains("title-no-drag")).toBe(true);
    await click(button(toggle!, "Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(updateSettings).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("persists skip before entering the app and exposes settings repair actions", async () => {
    const { api, updateSettings, list } = createApi([projectA], false);
    const container = await renderApp(api);

    await click(button(container, "Configure later"));

    expect(updateSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
    expect(list).toHaveBeenCalledOnce();
    const repairs = [...container.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent?.trim() === "Open settings");
    expect(repairs.length).toBeGreaterThanOrEqual(2);
    await click(repairs[0]!);
    expect(container.textContent).toContain("Model services");
  });

  it("keeps onboarding open and announces a sanitized settings persistence error", async () => {
    const { api, updateSettings, list } = createApi([], false);
    updateSettings.mockResolvedValueOnce({
      ok: false,
      error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: false }
    });
    const container = await renderApp(api);

    await click(button(container, "Configure later"));

    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "The model service could not complete the request. Try again."
    );
    expect(container.textContent).toContain("Welcome to MyNotebookLM");
    expect(list).not.toHaveBeenCalled();
  });

  it("opens model settings from the real sidebar button", async () => {
    const { api, listProfiles, getDefaultRoutes } = createApi([], true);
    const container = await renderApp(api);

    await click(button(container, "Settings"));

    expect(container.textContent).toContain("Model services");
    expect(listProfiles).toHaveBeenCalledOnce();
    expect(getDefaultRoutes).toHaveBeenCalledTimes(2);
  });

  it("validates and saves editable profiles before explicitly persisting both routes", async () => {
    const { api, listProfiles, testModel, saveProfile, setDefaultRoutes, updateSettings } =
      createApi([], false);
    listProfiles.mockResolvedValueOnce({
      ok: true,
      value: { profiles: [], builtInProfiles: [builtInEmbedding], credentials: [] }
    });
    const container = await renderApp(api);
    const forms = container.querySelectorAll<HTMLElement>(".model-profile-form");
    expect(forms).toHaveLength(2);

    await setField(labelledField<HTMLSelectElement>(forms[0]!, "Provider"), "ollama");
    await click(button(forms[0]!, "Enter model name manually"));
    await setField(labelledField<HTMLInputElement>(forms[0]!, "Model name"), "llama3.2");
    await setField(labelledField<HTMLSelectElement>(forms[1]!, "Provider"), "local");
    await click(button(container, "Finish and start"));

    expect(testModel).toHaveBeenCalledOnce();
    expect(saveProfile).toHaveBeenCalledOnce();
    expect(setDefaultRoutes).toHaveBeenCalledOnce();
    expect(setDefaultRoutes).toHaveBeenCalledWith({
      generationProfileId: expect.any(String),
      embeddingProfileId: builtInEmbedding.id
    });
    expect(updateSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
  });

  it("completes onboarding with a keyless OpenAI-compatible loopback profile", async () => {
    const { api, listProfiles, testModel, saveProfile, setDefaultRoutes, updateSettings } =
      createApi([], false);
    listProfiles.mockResolvedValueOnce({
      ok: true,
      value: { profiles: [], builtInProfiles: [builtInEmbedding], credentials: [] }
    });
    const container = await renderApp(api);
    const forms = container.querySelectorAll<HTMLElement>(".model-profile-form");
    await setField(
      labelledField<HTMLInputElement>(forms[0]!, "API address"),
      "http://localhost:1234/v1"
    );
    await click(button(forms[0]!, "Enter model name manually"));
    await setField(labelledField<HTMLInputElement>(forms[0]!, "Model name"), "self-hosted-model");
    await setField(labelledField<HTMLSelectElement>(forms[1]!, "Provider"), "local");

    await click(button(container, "Finish and start"));

    expect(testModel).toHaveBeenCalledWith({
      profile: expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        modelId: "self-hosted-model"
      })
    });
    expect(saveProfile).toHaveBeenCalledWith({
      profile: expect.objectContaining({ provider: "openai-compatible" })
    });
    expect(setDefaultRoutes).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
  });

  it("saves keyless OpenAI-compatible changes from settings", async () => {
    const { api, listProfiles, getDefaultRoutes, testModel, saveProfile, setDefaultRoutes } =
      createApi([], true);
    listProfiles.mockResolvedValue({
      ok: true,
      value: { profiles: [], builtInProfiles: [builtInEmbedding], credentials: [] }
    });
    getDefaultRoutes.mockResolvedValue({ ok: true, value: {} });
    const container = await renderApp(api);
    await click(button(container, "Settings"));
    const forms = container.querySelectorAll<HTMLElement>(".model-profile-form");
    await setField(
      labelledField<HTMLInputElement>(forms[0]!, "API address"),
      "http://localhost:1234/v1"
    );
    await click(button(forms[0]!, "Enter model name manually"));
    await setField(labelledField<HTMLInputElement>(forms[0]!, "Model name"), "self-hosted-model");
    await setField(labelledField<HTMLSelectElement>(forms[1]!, "Provider"), "local");

    await click(button(container, "Save changes"));

    expect(testModel).toHaveBeenCalledWith({
      profile: expect.objectContaining({ provider: "openai-compatible" })
    });
    expect(saveProfile).toHaveBeenCalledWith({
      profile: expect.objectContaining({ provider: "openai-compatible" })
    });
    expect(setDefaultRoutes).toHaveBeenCalledOnce();
  });

  it("edits a saved credential-free Ollama endpoint from settings", async () => {
    const { api, listProfiles, getDefaultRoutes, testModel, saveProfile } = createApi([], true);
    listProfiles.mockResolvedValue({
      ok: true,
      value: {
        profiles: [{
          id: projectA.id,
          name: "Local Ollama",
          provider: "ollama",
          capability: "generation",
          baseUrl: "http://127.0.0.1:11434",
          modelId: "llama3.2",
          enabled: true,
          createdAt: "2026-08-25T00:00:00.000Z",
          updatedAt: "2026-08-25T00:00:00.000Z"
        }],
        builtInProfiles: [builtInEmbedding],
        credentials: []
      }
    });
    getDefaultRoutes.mockResolvedValue({
      ok: true,
      value: { generationProfileId: projectA.id, embeddingProfileId: builtInEmbedding.id }
    });
    const container = await renderApp(api);
    await click(button(container, "Settings"));
    const generation = container.querySelectorAll<HTMLElement>(".model-profile-form")[0]!;

    await setField(
      labelledField<HTMLInputElement>(generation, "API address"),
      "http://localhost:11435"
    );
    await click(button(container, "Save changes"));

    expect(testModel).toHaveBeenCalledWith({
      profile: expect.objectContaining({
        provider: "ollama",
        baseUrl: "http://localhost:11435",
        modelId: "llama3.2"
      })
    });
    expect(saveProfile).toHaveBeenCalledWith({
      profile: expect.objectContaining({ baseUrl: "http://localhost:11435" })
    });
  });

  it("locks both complete model forms while onboarding persistence is in flight", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopApi["models"]["test"]>>>();
    const { api, listProfiles, testModel } = createApi([], false);
    listProfiles.mockResolvedValueOnce({
      ok: true,
      value: { profiles: [], builtInProfiles: [builtInEmbedding], credentials: [] }
    });
    testModel.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const forms = container.querySelectorAll<HTMLElement>(".model-profile-form");
    await setField(labelledField<HTMLSelectElement>(forms[0]!, "Provider"), "ollama");
    await click(button(forms[0]!, "Enter model name manually"));
    await setField(labelledField<HTMLInputElement>(forms[0]!, "Model name"), "llama3.2");
    await setField(labelledField<HTMLSelectElement>(forms[1]!, "Provider"), "local");

    await click(button(container, "Finish and start"));

    expect([...container.querySelectorAll(".model-profile-form input, .model-profile-form select, .model-profile-form button")]
      .every((control) => control.matches(":disabled"))).toBe(true);
    await act(async () => {
      pending.resolve({
        ok: true,
        value: { modelId: "llama3.2", capability: "generation", verifiedBy: "probe" }
      });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("locks both complete model forms while settings persistence is in flight", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopApi["models"]["test"]>>>();
    const { api, listProfiles, getDefaultRoutes, testModel } = createApi([], true);
    listProfiles.mockResolvedValue({
      ok: true,
      value: { profiles: [], builtInProfiles: [builtInEmbedding], credentials: [] }
    });
    getDefaultRoutes.mockResolvedValue({ ok: true, value: {} });
    const container = await renderApp(api);
    await click(button(container, "Settings"));
    const forms = container.querySelectorAll<HTMLElement>(".model-profile-form");
    await setField(labelledField<HTMLSelectElement>(forms[0]!, "Provider"), "ollama");
    await click(button(forms[0]!, "Enter model name manually"));
    await setField(labelledField<HTMLInputElement>(forms[0]!, "Model name"), "llama3.2");
    await setField(labelledField<HTMLSelectElement>(forms[1]!, "Provider"), "local");
    testModel.mockReturnValueOnce(pending.promise);

    await click(button(container, "Save changes"));

    expect([...container.querySelectorAll(".model-profile-form input, .model-profile-form select, .model-profile-form button")]
      .every((control) => control.matches(":disabled"))).toBe(true);
    await act(async () => {
      pending.resolve({
        ok: true,
        value: { modelId: "llama3.2", capability: "generation", verifiedBy: "probe" }
      });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("focuses and announces a retryable settings load failure", async () => {
    const { api, listProfiles } = createApi([], true);
    listProfiles.mockResolvedValueOnce({
      ok: false,
      error: { code: "NETWORK", messageKey: "errors.network", recoverable: true }
    });
    const container = await renderApp(api);

    await click(button(container, "Settings"));

    const alert = container.querySelector<HTMLElement>(".settings-load-error[role=alert]");
    expect(alert?.textContent).toContain("Could not load model settings");
    expect(document.activeElement).toBe(alert);
    listProfiles.mockResolvedValueOnce({
      ok: true,
      value: { profiles: [], builtInProfiles: [], credentials: [] }
    });
    await click(button(container, "Retry"));
    expect(container.textContent).toContain("Model services");
  });

  it("loads projects once under React Strict Mode", async () => {
    const { api, list } = createApi([projectA]);

    const container = await renderApp(api);

    expect(list).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain(projectA.name);
  });

  it("ignores stale retry success and failure after a newer archive rejection", async () => {
    const oldSuccess = deferred<ProjectDto[]>();
    const oldFailure = deferred<ProjectDto[]>();
    const { api, list, archive } = createApi([projectA, projectB]);
    list
      .mockResolvedValueOnce([projectA, projectB])
      .mockRejectedValueOnce(new Error("authoritative refresh failed"))
      .mockReturnValueOnce(oldSuccess.promise)
      .mockReturnValueOnce(oldFailure.promise);
    archive.mockRejectedValueOnce(new Error("archive failed"));
    const container = await renderApp(api);

    await click(button(container, "New project"));
    await enterProjectName(container, "Create before retry");
    await click(button(container, "Confirm"));
    const retry = button(container, "↻");
    await click(retry);
    await click(retry);

    const firstTrigger = container.querySelector<HTMLButtonElement>(".menu-trigger");
    if (!firstTrigger) throw new Error("Missing first project menu trigger");
    await click(firstTrigger);
    await click(button(document, "Archive"));
    expect(document.querySelector(".project-popover .inline-error")?.textContent).toBe("Could not archive the project.");

    await act(async () => {
      oldSuccess.resolve([projectB]);
      await oldSuccess.promise;
      oldFailure.reject(new Error("old retry failed"));
      await oldFailure.promise.catch(() => undefined);
    });

    expect(container.querySelector('.project-select[aria-current="page"]')?.textContent).toContain(projectA.name);
    expect(firstTrigger.isConnected).toBe(true);
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".project-popover .inline-error")?.textContent).toBe("Could not archive the project.");
  });

  it("translates a visible error when the language changes", async () => {
    const { api, list } = createApi();
    list.mockRejectedValueOnce(new Error("load failed"));
    const container = await renderApp(api);

    expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not load projects. Try again.");
    await click(button(container, "中文"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("无法加载项目，请重试。");
  });

  it("refreshes after create and renders authoritative list order", async () => {
    const { api, list, create } = createApi();
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([projectB, projectA]);
    const container = await renderApp(api);

    await click(button(container, "New project"));
    await enterProjectName(container, "Draft project");
    await click(button(container, "Confirm"));

    expect(create).toHaveBeenCalledWith({ name: "Draft project" });
    expect(list).toHaveBeenCalledTimes(2);
    expect([...container.querySelectorAll(".project-copy strong")].map((node) => node.textContent)).toEqual([
      projectB.name,
      projectA.name
    ]);
  });

  it("keeps a create failure scoped to the open dialog", async () => {
    const { api, create } = createApi();
    create.mockRejectedValueOnce(new Error("database unavailable"));
    const container = await renderApp(api);

    await click(button(container, "New project"));
    await enterProjectName(container, "Failure case");
    await click(button(container, "Confirm"));

    expect(document.querySelector("[role=dialog] .inline-error")?.textContent).toBe("Could not create the project.");
    expect(container.querySelector(".load-error")).toBeNull();
  });

  it("blocks the background and contains focus until Escape dismisses delete", async () => {
    const { api } = createApi([projectA]);
    const container = await renderApp(api);
    const menu = container.querySelector<HTMLButtonElement>(".menu-trigger");
    if (!menu) throw new Error("Missing project menu");

    await click(menu);
    await click(button(document, "Delete project"));

    const shell = container.querySelector<HTMLElement>(".app-shell");
    const overlay = document.body.querySelector<HTMLElement>(".dialog-layer");
    const alertDialog = document.querySelector<HTMLElement>("[role=alertdialog]");
    const confirm = button(container, "Confirm");
    const cancel = button(container, "Cancel");
    if (!shell || !overlay || !alertDialog) throw new Error("Missing delete dialog structure");
    expect(container.querySelector(".dialog-layer")).toBeNull();
    expect(overlay.parentElement).toBe(document.body);
    expect(getComputedStyle(overlay).position).toBe("fixed");
    expect(getComputedStyle(overlay).getPropertyValue("inset")).toBe("0");
    expect(getComputedStyle(overlay).display).toBe("grid");
    expect(getComputedStyle(overlay).placeItems).toBe("center");
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(confirm);

    button(container, "New project").focus();
    expect(document.activeElement).toBe(confirm);
    confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(shell.hasAttribute("inert")).toBe(false);
  });

  it("locks a deferred mutation to its originating dialog and keeps rejection visible", async () => {
    const pending = deferred<ProjectDto>();
    const { api, rename } = createApi([projectA]);
    rename.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const menu = container.querySelector<HTMLButtonElement>(".menu-trigger");
    if (!menu) throw new Error("Missing project menu");

    await click(menu);
    await click(button(document, "Rename"));
    await enterProjectName(container, "Deferred rename");
    await click(button(container, "Confirm"));
    const overlay = document.body.querySelector<HTMLElement>(".dialog-layer");
    if (!overlay) throw new Error("Missing dialog overlay");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    await click(button(container, "New project"));

    expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("Rename");
    expect(document.querySelector<HTMLInputElement>("#project-name")?.value).toBe("Deferred rename");

    await act(async () => {
      pending.reject(new Error("rename failed"));
      await Promise.resolve();
    });
    expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("Rename");
    expect(document.querySelector("[role=dialog] .inline-error")?.textContent).toBe("Could not rename the project.");
  });

  it("keeps a deferred archive owned by its menu through every dismissal path", async () => {
    const pending = deferred<ProjectDto>();
    const { api, archive } = createApi([projectA, projectB]);
    archive.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const triggers = container.querySelectorAll<HTMLButtonElement>(".menu-trigger");
    const firstTrigger = triggers.item(0);
    const secondTrigger = triggers.item(1);

    await click(firstTrigger);
    const archiveAction = button(document, "Archive");
    await click(archiveAction);
    await click(archiveAction);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      container.querySelector<HTMLElement>(".workspace")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await click(secondTrigger);

    expect(archive).toHaveBeenCalledOnce();
    expect(document.querySelector(".project-popover")).not.toBeNull();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      pending.reject(new Error("archive failed"));
      await Promise.resolve();
    });
    expect(document.querySelector(".project-popover .inline-error")?.textContent).toBe("Could not archive the project.");
    expect(button(document, "Archive").disabled).toBe(false);
  });

  it("blocks pointer and keyboard project selection while archive owns its menu", async () => {
    const pending = deferred<ProjectDto>();
    const { api, archive } = createApi([projectA, projectB]);
    archive.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const selects = container.querySelectorAll<HTMLButtonElement>(".project-select");
    const triggers = container.querySelectorAll<HTMLButtonElement>(".menu-trigger");
    const firstSelect = selects.item(0);
    const secondSelect = selects.item(1);
    const firstTrigger = triggers.item(0);

    await click(firstTrigger);
    await click(button(document, "Archive"));
    const selectionDisabledWhileBusy = secondSelect.disabled;
    await act(async () => {
      secondSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      secondSelect.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      secondSelect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      secondSelect.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      secondSelect.click();
      secondSelect.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      pending.reject(new Error("archive failed"));
      await Promise.resolve();
    });

    expect(firstSelect.getAttribute("aria-current")).toBe("page");
    expect(secondSelect.getAttribute("aria-current")).toBeNull();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".project-popover .inline-error")?.textContent).toBe("Could not archive the project.");
    expect(selectionDisabledWhileBusy).toBe(true);

    expect(secondSelect.disabled).toBe(false);
    await click(secondSelect);
    expect(secondSelect.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("[role=menu]")).toBeNull();
  });

  it("restores focus to a connected dialog opener on Escape, Cancel, and backdrop", async () => {
    const { api } = createApi();
    const container = await renderApp(api);
    const opener = button(container, "New project");

    opener.focus();
    await click(opener);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);

    await click(opener);
    await click(button(container, "Cancel"));
    expect(document.activeElement).toBe(opener);

    await click(opener);
    const overlay = document.body.querySelector<HTMLElement>(".dialog-layer");
    if (!overlay) throw new Error("Missing dialog overlay");
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);
  });

  it("restores focus to a connected menu trigger on non-commit dismissals", async () => {
    const { api } = createApi([projectA]);
    const container = await renderApp(api);
    const trigger = container.querySelector<HTMLButtonElement>(".menu-trigger");
    const outside = container.querySelector<HTMLElement>(".workspace");
    if (!trigger || !outside) throw new Error("Missing menu focus fixtures");

    const dismissAndCheck = async (dismiss: () => void): Promise<void> => {
      await click(trigger);
      expect(document.activeElement).toBe(button(document, "Rename"));
      await act(async () => {
        dismiss();
        await Promise.resolve();
      });
      expect(document.querySelector(".project-popover")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    };

    await dismissAndCheck(() => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await dismissAndCheck(() => document.dispatchEvent(new Event("scroll", { bubbles: true })));
    await dismissAndCheck(() => window.dispatchEvent(new Event("resize")));
    await dismissAndCheck(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });

  it("keeps the project list as the independently scrollable middle region", async () => {
    const { api } = createApi();
    const container = await renderApp(api);
    const sidebar = container.querySelector(".sidebar");
    const nav = container.querySelector<HTMLElement>(".project-nav");
    const list = container.querySelector<HTMLElement>(".project-list");
    if (!sidebar || !nav || !list) throw new Error("Missing sidebar structure");

    expect(document.styleSheets[0]?.cssRules.length).toBeGreaterThan(0);
    expect(sidebar.firstElementChild?.classList.contains("brand")).toBe(true);
    expect(sidebar.lastElementChild?.classList.contains("sidebar-footer")).toBe(true);
    expect(getComputedStyle(nav).display).toBe("flex");
    expect(getComputedStyle(nav).minHeight).toBe("0");
    expect(getComputedStyle(list).overflowY).toBe("auto");
    expect(getComputedStyle(list).minHeight).toBe("0");
  });

  it("uses native drag regions without custom title controls and keeps interactive controls clickable", async () => {
    const { api } = createApi();
    const container = await renderApp(api);
    const dragRegions = container.querySelectorAll(".title-drag-region");
    const create = button(container, "New project");

    expect(dragRegions).toHaveLength(2);
    expect(container.querySelector(".window-control")).toBeNull();
    expect(create.classList.contains("title-no-drag")).toBe(true);
  });

  it("updates the native title-overlay symbols through the isolated theme command", async () => {
    const { api, setTitleOverlayTheme } = createApi();
    const container = await renderApp(api);

    await click(button(container, "Dark"));

    expect(setTitleOverlayTheme).toHaveBeenNthCalledWith(1, { theme: "light" });
    expect(setTitleOverlayTheme).toHaveBeenNthCalledWith(2, { theme: "dark" });
    expect(setTitleOverlayTheme).toHaveBeenCalledTimes(2);
  });

  it("synchronizes a restored dark theme to the title overlay on startup", async () => {
    const { api, setTitleOverlayTheme, getSettings } = createApi();
    getSettings.mockResolvedValueOnce({
      ok: true,
      value: { onboardingCompleted: true, locale: "en", theme: "dark" }
    });
    changeTheme("dark");

    await renderApp(api);

    expect(setTitleOverlayTheme).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
  });

  it("keeps a light startup correct when the title-overlay update rejects", async () => {
    const { api, setTitleOverlayTheme } = createApi();
    setTitleOverlayTheme.mockRejectedValueOnce(new Error("overlay unavailable"));

    await renderApp(api);

    expect(setTitleOverlayTheme).toHaveBeenCalledExactlyOnceWith({ theme: "light" });
  });

  it("renders the approved disabled import formats, guidance, composer, and citations", async () => {
    const { api } = createApi([projectA]);
    const container = await renderApp(api);
    const formats = [...container.querySelectorAll<HTMLButtonElement>(".format-choice")];

    expect(container.querySelector(".import-region")).not.toBeNull();
    expect(formats.map((choice) => choice.textContent?.trim())).toEqual([
      "PDF", "DOCX", "PPTX", "XLSX", "TXT", "Markdown", "URL", "CSV"
    ]);
    expect(formats.every((choice) => choice.disabled)).toBe(true);
    expect(container.querySelector(".guidance-card")).not.toBeNull();
    expect(button(container, "Import sources").disabled).toBe(true);
    expect(button(container, "Ask about this project").disabled).toBe(true);
    expect(container.querySelector(".sources-empty")?.textContent).toContain("No sources yet");
  });

  it("renders distinct deferred messages while keeping settings actionable", async () => {
    const { api } = createApi([projectA]);
    const container = await renderApp(api);
    const importButton = button(container, "Import sources");
    const settings = button(container, "Settings");

    expect(importButton.title).toBe("Source import will be available in a later step.");
    expect(container.querySelector(".workspace-empty p")?.textContent).toBe(
      "Source import will be available in a later step."
    );
    expect(container.querySelector(".composer span")?.textContent).toBe(
      "Research chat will be available after source import."
    );
    expect(settings.disabled).toBe(false);
    expect(settings.title).toBe("");

    await click(button(container, "中文"));

    expect(importButton.title).toBe("资料导入将在后续步骤中提供。");
    expect(container.querySelector(".composer span")?.textContent).toBe(
      "研究对话将在资料导入功能提供后可用。"
    );
    expect(settings.textContent).toContain("设置");
  });

  it("uses a labelled ordinary popover for project actions", async () => {
    const { api } = createApi([projectA]);
    const container = await renderApp(api);
    const trigger = container.querySelector<HTMLButtonElement>(".menu-trigger");
    if (!trigger) throw new Error("Missing project menu trigger");

    await click(trigger);

    const popover = document.querySelector<HTMLElement>(".project-popover");
    expect(popover?.getAttribute("role")).toBe("group");
    expect(popover?.getAttribute("aria-label")).toBe("Project actions");
    expect(popover?.querySelectorAll("button[role]")).toHaveLength(0);
    expect(document.querySelector("[role=menu]")).toBeNull();
  });

  it("portals and flips the last project action popover inside visible app bounds", async () => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1100 },
      innerHeight: { configurable: true, value: 768 }
    });
    const projects = Array.from({ length: 20 }, (_, index): ProjectDto => ({
      ...projectA,
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
      name: `Project ${index + 1}`
    }));
    const { api } = createApi(projects);
    const container = await renderApp(api);
    const triggers = container.querySelectorAll<HTMLButtonElement>(".menu-trigger");
    const lastTrigger = triggers.item(triggers.length - 1);
    vi.spyOn(lastTrigger, "getBoundingClientRect").mockReturnValue({
      x: 230,
      y: 724,
      top: 724,
      right: 276,
      bottom: 760,
      left: 230,
      width: 46,
      height: 36,
      toJSON: () => ({})
    });

    await click(lastTrigger);

    const popover = document.querySelector<HTMLElement>(".project-popover");
    if (!popover) throw new Error("Missing portaled project action popover");
    const top = Number.parseFloat(popover.style.top);
    const left = Number.parseFloat(popover.style.left);
    expect(container.querySelector(".project-popover")).toBeNull();
    expect(getComputedStyle(popover).position).toBe("fixed");
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 132).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 154).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(document.activeElement).toBe(button(document, "Rename"));
    expect(button(document, "Rename").disabled).toBe(false);
    expect(button(document, "Archive").disabled).toBe(false);
    expect(button(document, "Delete project").disabled).toBe(false);
  });
});
