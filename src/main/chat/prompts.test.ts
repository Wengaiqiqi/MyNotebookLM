import { describe, expect, it } from "vitest";
import { buildSystemPrompt, PROMPT_LOCALES } from "./prompts";

describe("buildSystemPrompt", () => {
  it("produces identical deterministic prompts per locale", () => {
    for (const locale of PROMPT_LOCALES) {
      expect(buildSystemPrompt(locale)).toBe(buildSystemPrompt(locale));
    }
    expect(PROMPT_LOCALES).toEqual(["en", "zh"]);
  });

  it("provides distinct bilingual prompts with grounding, citation and no-evidence rules", () => {
    const en = buildSystemPrompt("en");
    const zh = buildSystemPrompt("zh");

    expect(en).not.toBe(zh);
    expect(en).toMatch(/\[S(?:[1-9]|1[0-2])\]/);
    expect(en.toLowerCase()).toContain("evidence");
    expect(en.toLowerCase()).toContain("no evidence");

    expect(zh).toMatch(/\[S(?:[1-9]|1[0-2])\]/);
    expect(zh).toContain("证据");
    expect(zh).toContain("没有足够");
  });
});
