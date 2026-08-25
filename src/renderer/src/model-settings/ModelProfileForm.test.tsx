// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../shared/ipc";
import type {
  BuiltInModelProfileDto,
  CredentialStatusDto,
  ModelProfileDto
} from "../../../shared/models";
import ModelProfileForm, { type ModelProfileDraft } from "./ModelProfileForm";
import { changeLanguage } from "../i18n";

const savedProfile: ModelProfileDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Saved OpenAI",
  provider: "openai",
  capability: "generation",
  baseUrl: "https://saved.example/v1",
  modelId: "saved-model",
  enabled: true,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z"
};

const builtInProfile: BuiltInModelProfileDto = {
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

const roots: Root[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function createApi() {
  const discover = vi.fn<DesktopApi["models"]["discover"]>();
  window.myNotebook = {
    models: { discover }
  } as unknown as DesktopApi;
  return { discover };
}

async function renderForm(props: Partial<React.ComponentProps<typeof ModelProfileForm>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  let latest: ModelProfileDraft | undefined;
  await act(async () => {
    root.render(
      <ModelProfileForm
        capability="generation"
        profiles={[]}
        builtInProfiles={[]}
        credentials={[]}
        onChange={(draft) => { latest = draft; }}
        {...props}
      />
    );
    await Promise.resolve();
  });
  return { container, latest: () => latest };
}

function field<T extends HTMLInputElement | HTMLSelectElement>(container: ParentNode, label: string): T {
  const element = [...container.querySelectorAll<T>("input, select")]
    .find((candidate) => candidate.labels?.[0]?.firstChild?.textContent?.trim() === label);
  if (!element) throw new Error(`Missing field: ${label}`);
  return element;
}

function button(container: ParentNode, name: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return element;
}

async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  localStorage.clear();
  await changeLanguage("en");
  createApi();
});

afterEach(async () => {
  await act(async () => {
    while (roots.length) roots.pop()?.unmount();
  });
  vi.restoreAllMocks();
});

describe("ModelProfileForm", () => {
  it("fills provider defaults without overwriting an edited address", async () => {
    const { container } = await renderForm();
    const provider = field<HTMLSelectElement>(container, "Provider");
    const address = field<HTMLInputElement>(container, "API address");

    expect(provider.value).toBe("openai-compatible");
    expect(address.value).toBe("https://api.openai.com/v1");
    await setValue(provider, "anthropic");
    expect(address.value).toBe("https://api.anthropic.com");
    await setValue(address, "https://gateway.example/v1");
    await setValue(provider, "gemini");
    expect(address.value).toBe("https://gateway.example/v1");
    expect(address.readOnly).toBe(false);
  });

  it("loads a saved profile and uses a fixed unchanged-credential mask", async () => {
    const credentials: CredentialStatusDto[] = [{
      profileId: savedProfile.id,
      hasCredential: true,
      mask: "unsafe-provider-mask"
    }];
    const { container, latest } = await renderForm({ profiles: [savedProfile], credentials });

    await setValue(field<HTMLSelectElement>(container, "Saved profile"), savedProfile.id);

    expect(field<HTMLSelectElement>(container, "Provider").value).toBe("openai");
    expect(field<HTMLInputElement>(container, "API address").value).toBe(savedProfile.baseUrl);
    expect(field<HTMLSelectElement>(container, "Model").value).toBe(savedProfile.modelId);
    expect(field<HTMLInputElement>(container, "API key").placeholder).toBe("••••••••");
    expect(container.textContent).not.toContain("unsafe-provider-mask");
    expect(latest()?.hasStoredCredential).toBe(true);
    expect(latest()?.profile.id).toBe(savedProfile.id);
  });

  it("hides credentials for Ollama and exposes built-in local embedding as immutable", async () => {
    const generation = await renderForm();
    await setValue(field<HTMLSelectElement>(generation.container, "Provider"), "ollama");
    expect(generation.container.querySelector('input[type="password"]')).toBeNull();
    expect(field<HTMLInputElement>(generation.container, "API address").value).toBe("http://127.0.0.1:11434");

    const embedding = await renderForm({
      capability: "embedding",
      builtInProfiles: [builtInProfile]
    });
    await setValue(field<HTMLSelectElement>(embedding.container, "Provider"), "local");
    expect(embedding.container.textContent).toContain("Xenova/multilingual-e5-small");
    expect(embedding.container.querySelector('input[name="apiKey"]')).toBeNull();
    expect(embedding.container.querySelector('input[name="baseUrl"]')).toBeNull();
    expect(embedding.latest()?.valid).toBe(true);
  });

  it("restores a persisted built-in embedding route without exposing editable connection fields", async () => {
    const { container, latest } = await renderForm({
      capability: "embedding",
      builtInProfiles: [builtInProfile],
      initialProfileId: builtInProfile.id
    });

    expect(field<HTMLSelectElement>(container, "Provider").value).toBe("local");
    expect(container.querySelector('input[name="baseUrl"]')).toBeNull();
    expect(latest()?.profile.id).toBe(builtInProfile.id);
  });

  it("shows discovery success only after success and filters wrong-capability models", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopApi["models"]["discover"]>>>();
    const discover = vi.fn<DesktopApi["models"]["discover"]>().mockReturnValueOnce(pending.promise);
    window.myNotebook.models.discover = discover;
    const { container } = await renderForm();
    await setValue(field<HTMLInputElement>(container, "API key"), "new-secret");

    const getModels = button(container, "Get models");
    await click(getModels);
    expect(container.querySelector("[role=status]")?.textContent).not.toContain("Fetched successfully");
    expect(getModels.disabled).toBe(true);
    await act(async () => {
      pending.resolve({
        ok: true,
        value: [
          { id: "gpt-test", displayName: "GPT Test", capabilities: ["generation"], capabilityEvidence: "authoritative" },
          { id: "embed-test", displayName: "Embed Test", capabilities: ["embedding"], capabilityEvidence: "authoritative" }
        ]
      });
      await pending.promise;
    });

    expect(container.querySelector("[role=status]")?.textContent).toContain("Fetched successfully");
    const model = field<HTMLSelectElement>(container, "Model");
    expect([...model.options].map((option) => option.value)).toContain("gpt-test");
    expect([...model.options].map((option) => option.value)).not.toContain("embed-test");
  });

  it("switches from discovered dropdown to a focused manual model-name input", async () => {
    window.myNotebook.models.discover = vi.fn<DesktopApi["models"]["discover"]>().mockResolvedValue({
      ok: true,
      value: [{
        id: "gpt-test",
        displayName: "GPT Test",
        capabilities: ["generation"],
        capabilityEvidence: "authoritative"
      }]
    });
    const { container, latest } = await renderForm();
    await setValue(field<HTMLInputElement>(container, "API key"), "new-secret");
    await click(button(container, "Get models"));
    expect(field<HTMLSelectElement>(container, "Model").value).toBe("gpt-test");

    await click(button(container, "Enter model name manually"));
    const manual = field<HTMLInputElement>(container, "Model name");
    expect(document.activeElement).toBe(manual);
    await setValue(manual, "manual-model");
    expect(latest()?.profile.modelId).toBe("manual-model");
    expect(latest()?.apiKey).toBe("new-secret");
    expect(latest()?.valid).toBe(true);
  });

  it("reports an accessible validation error before discovery when a required key is missing", async () => {
    const { container } = await renderForm();

    await click(button(container, "Get models"));

    expect(container.querySelector("[role=alert]")?.textContent).toBe("Enter an API key.");
    expect(window.myNotebook.models.discover).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field<HTMLInputElement>(container, "API key"));
  });

  it("labels the key independently and reveals only the transient typed value", async () => {
    const { container } = await renderForm();
    const key = field<HTMLInputElement>(container, "API key");
    await setValue(key, "transient-secret");

    expect(key.labels?.[0]?.textContent).toBe("API key");
    expect(key.type).toBe("password");
    await click(button(container, "Show API key"));
    expect(key.type).toBe("text");
    expect(key.value).toBe("transient-secret");
    expect(Object.values(localStorage).join(" ")).not.toContain("transient-secret");
  });
});
