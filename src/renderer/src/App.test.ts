import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

let App: (typeof import("./App"))["default"];

beforeAll(async () => {
  vi.stubGlobal("React", { createElement });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => key.endsWith("language") ? "en" : "light",
    setItem: vi.fn()
  });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  App = (await import("./App")).default;
});

describe("App shell", () => {
  it("renders accessible project navigation and disables later research actions", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toMatch(/<nav[^>]*aria-label="Research projects"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Import sources"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Available after sources are added"/);
  });
});
