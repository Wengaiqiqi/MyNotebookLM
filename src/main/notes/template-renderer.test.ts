import { describe, expect, it } from "vitest";
import { renderTransformationPrompt } from "./template-renderer";

describe("renderTransformationPrompt", () => {
  it("replaces exactly the four allowed placeholders", () => {
    expect(renderTransformationPrompt(
      "{{content}} | {{source_title}} | {{project_name}} | {{language}}",
      { content: "正文", sourceTitle: "来源", projectName: "项目", language: "zh-CN" }
    )).toBe("正文 | 来源 | 项目 | zh-CN");
  });

  it("renders missing values as empty strings", () => {
    expect(renderTransformationPrompt("A{{content}}B{{source_title}}C{{project_name}}D{{language}}E", {})).toBe("ABCDE");
  });

  it("rejects unknown, malformed, and script templates", () => {
    for (const template of ["{{unknown}}", "{{content", "{{ content }}", "<script>{{content}}</script>", "<% content %>"]) {
      expect(() => renderTransformationPrompt(template, {})).toThrow();
    }
  });

  it("does not interpret template syntax inserted through untrusted values", () => {
    expect(renderTransformationPrompt("Answer: {{content}}", {
      content: "literal {{source_title}} ${process.env.SECRET}"
    })).toBe("Answer: literal {{source_title}} ${process.env.SECRET}");
  });
});
