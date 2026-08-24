// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../shared/ipc";
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

type ApiDouble = {
  api: DesktopApi;
  list: ReturnType<typeof vi.fn<DesktopApi["projects"]["list"]>>;
  create: ReturnType<typeof vi.fn<DesktopApi["projects"]["create"]>>;
};

const roots: Root[] = [];

function createApi(projects: ProjectDto[] = []): ApiDouble {
  const list = vi.fn<DesktopApi["projects"]["list"]>().mockResolvedValue(projects);
  const create = vi.fn<DesktopApi["projects"]["create"]>().mockResolvedValue(projectA);
  return {
    list,
    create,
    api: {
      projects: {
        list,
        create,
        rename: vi.fn<DesktopApi["projects"]["rename"]>().mockResolvedValue(projectA),
        archive: vi.fn<DesktopApi["projects"]["archive"]>().mockResolvedValue(projectA),
        remove: vi.fn<DesktopApi["projects"]["remove"]>().mockResolvedValue(undefined)
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

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => {
      const text = candidate.textContent?.trim();
      return text === name || text?.endsWith(name);
    }
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function enterProjectName(container: HTMLElement, name: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#project-name");
  if (!input) throw new Error("Missing project name input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  it("loads projects once under React Strict Mode", async () => {
    const { api, list } = createApi([projectA]);

    const container = await renderApp(api);

    expect(list).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain(projectA.name);
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

    expect(container.querySelector("[role=dialog] .inline-error")?.textContent).toBe("Could not create the project.");
    expect(container.querySelector(".load-error")).toBeNull();
  });

  it("blocks the background and contains focus until Escape dismisses delete", async () => {
    const { api } = createApi([projectA]);
    const container = await renderApp(api);
    const menu = container.querySelector<HTMLButtonElement>("[aria-haspopup=menu]");
    if (!menu) throw new Error("Missing project menu");

    await click(menu);
    await click(button(container, "Delete project"));

    const shell = container.querySelector<HTMLElement>(".app-shell");
    const overlay = container.querySelector<HTMLElement>(".dialog-layer");
    const alertDialog = container.querySelector<HTMLElement>("[role=alertdialog]");
    const confirm = button(container, "Confirm");
    const cancel = button(container, "Cancel");
    if (!shell || !overlay || !alertDialog) throw new Error("Missing delete dialog structure");
    expect(getComputedStyle(overlay).position).toBe("fixed");
    expect(getComputedStyle(overlay).getPropertyValue("inset")).toBe("0");
    expect(getComputedStyle(overlay).gridTemplateColumns).toContain("var(--sidebar-width)");
    expect(getComputedStyle(alertDialog).gridColumn).toBe("2");
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(confirm);

    button(container, "New project").focus();
    expect(document.activeElement).toBe(confirm);
    confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector("[role=alertdialog]")).toBeNull();
    expect(shell.hasAttribute("inert")).toBe(false);
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
});
