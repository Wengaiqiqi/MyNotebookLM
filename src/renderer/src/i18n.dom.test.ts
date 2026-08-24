// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("locale and theme persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.lang = "";
    delete document.documentElement.dataset.theme;
  });

  it("applies the persisted initial locale to i18next and the document", async () => {
    localStorage.setItem("mynotebooklm.language", "en");

    const { default: i18n } = await import("./i18n");

    expect(i18n.resolvedLanguage).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists language and theme changes on the document", async () => {
    const { changeLanguage, changeTheme } = await import("./i18n");

    await changeLanguage("en");
    changeTheme("dark");

    expect(localStorage.getItem("mynotebooklm.language")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("mynotebooklm.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
