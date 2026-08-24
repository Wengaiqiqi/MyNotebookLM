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
  rename: ReturnType<typeof vi.fn<DesktopApi["projects"]["rename"]>>;
  archive: ReturnType<typeof vi.fn<DesktopApi["projects"]["archive"]>>;
};

const roots: Root[] = [];

function createApi(projects: ProjectDto[] = []): ApiDouble {
  const list = vi.fn<DesktopApi["projects"]["list"]>().mockResolvedValue(projects);
  const create = vi.fn<DesktopApi["projects"]["create"]>().mockResolvedValue(projectA);
  const rename = vi.fn<DesktopApi["projects"]["rename"]>().mockResolvedValue(projectA);
  const archive = vi.fn<DesktopApi["projects"]["archive"]>().mockResolvedValue(projectA);
  return {
    list,
    create,
    rename,
    archive,
    api: {
      projects: {
        list,
        create,
        rename,
        archive,
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

function button(container: ParentNode, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
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
    await click(button(document, "Delete project"));

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

  it("locks a deferred mutation to its originating dialog and keeps rejection visible", async () => {
    const pending = deferred<ProjectDto>();
    const { api, rename } = createApi([projectA]);
    rename.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const menu = container.querySelector<HTMLButtonElement>("[aria-haspopup=menu]");
    if (!menu) throw new Error("Missing project menu");

    await click(menu);
    await click(button(document, "Rename"));
    await enterProjectName(container, "Deferred rename");
    await click(button(container, "Confirm"));
    const overlay = container.querySelector<HTMLElement>(".dialog-layer");
    if (!overlay) throw new Error("Missing dialog overlay");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    await click(button(container, "New project"));

    expect(container.querySelector("[role=dialog] h2")?.textContent).toBe("Rename");
    expect(container.querySelector<HTMLInputElement>("#project-name")?.value).toBe("Deferred rename");

    await act(async () => {
      pending.reject(new Error("rename failed"));
      await Promise.resolve();
    });
    expect(container.querySelector("[role=dialog] h2")?.textContent).toBe("Rename");
    expect(container.querySelector("[role=dialog] .inline-error")?.textContent).toBe("Could not rename the project.");
  });

  it("keeps a deferred archive owned by its menu through every dismissal path", async () => {
    const pending = deferred<ProjectDto>();
    const { api, archive } = createApi([projectA, projectB]);
    archive.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const triggers = container.querySelectorAll<HTMLButtonElement>("[aria-haspopup=menu]");
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
    expect(document.querySelector("[role=menu]")).not.toBeNull();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      pending.reject(new Error("archive failed"));
      await Promise.resolve();
    });
    expect(document.querySelector("[role=menu] .inline-error")?.textContent).toBe("Could not archive the project.");
    expect(button(document, "Archive").disabled).toBe(false);
  });

  it("blocks pointer and keyboard project selection while archive owns its menu", async () => {
    const pending = deferred<ProjectDto>();
    const { api, archive } = createApi([projectA, projectB]);
    archive.mockReturnValueOnce(pending.promise);
    const container = await renderApp(api);
    const selects = container.querySelectorAll<HTMLButtonElement>(".project-select");
    const triggers = container.querySelectorAll<HTMLButtonElement>("[aria-haspopup=menu]");
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
    expect(document.querySelector("[role=menu] .inline-error")?.textContent).toBe("Could not archive the project.");
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
    const overlay = container.querySelector<HTMLElement>(".dialog-layer");
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
    const trigger = container.querySelector<HTMLButtonElement>("[aria-haspopup=menu]");
    const outside = container.querySelector<HTMLElement>(".workspace");
    if (!trigger || !outside) throw new Error("Missing menu focus fixtures");

    const dismissAndCheck = async (dismiss: () => void): Promise<void> => {
      await click(trigger);
      expect(document.activeElement).toBe(button(document, "Rename"));
      await act(async () => {
        dismiss();
        await Promise.resolve();
      });
      expect(document.querySelector("[role=menu]")).toBeNull();
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

  it("portals and flips the last project menu inside visible app bounds", async () => {
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
    const triggers = container.querySelectorAll<HTMLButtonElement>("[aria-haspopup=menu]");
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

    const menu = document.querySelector<HTMLElement>("[role=menu]");
    if (!menu) throw new Error("Missing portaled project menu");
    const top = Number.parseFloat(menu.style.top);
    const left = Number.parseFloat(menu.style.left);
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(getComputedStyle(menu).position).toBe("fixed");
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
