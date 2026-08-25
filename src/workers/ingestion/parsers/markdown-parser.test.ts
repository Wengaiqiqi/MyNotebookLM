import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown-parser";

describe("parseMarkdown", () => {
  it("emits heading ancestry, list, code and table text", () => {
    expect(parseMarkdown("# Root\n## Child\nbody\n- one\n- two\n```ts\nconst x = 1;\n```\n| A | B |\n|---|---|\n| 1 | 2 |"))
      .toMatchSnapshot();
  });
});
