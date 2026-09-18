// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import QuizPanel from "./QuizPanel";
import { parseQuiz } from "./quiz";
import "../../i18n";
import type { InsightDto } from "../../../../shared/transformations";

beforeEach(() => localStorage.clear());
afterEach(cleanup);
const makeInsight = (id: string, content: string): InsightDto => ({
  id, content, projectId: "project", builtinKey: "qa", transformationId: null, taskId: null,
  inputKind: "source", inputHash: null, ruleVersion: 1, provider: null, model: null,
  profileId: null, usage: null, idempotencyKey: id, createdAt: "", updatedAt: ""
});

it("parses current and legacy bilingual questions without including incomplete questions", () => {
  expect(parseQuiz("# 练习\n## 问：首都？\n答：北京\n\n1. **问：** 日期？\n   **答：**六月。\n## Q: Why?\nA: Because.\nMore detail.\n## Q: Incomplete"))
    .toEqual([{ question: "首都？", answer: "北京" }, { question: "日期？", answer: "六月。" }, { question: "Why?", answer: "Because.\nMore detail." }]);
  expect(parseQuiz("A plain summary.")).toEqual([]);
  expect(parseQuiz("1. **问：日期？**\n**答：**六月。\n## 问：解释 **重点**\n答：保留格式。"))
    .toEqual([{ question: "日期？", answer: "六月。" }, { question: "解释 **重点**", answer: "保留格式。" }]);
});

it("switches question sets, hides answers and persists independent attempts after remount", () => {
  const insights = [makeInsight("one", "# 地理\n## 问：首都？\n答：北京"), makeInsight("two", "# 数学\n## 问：一加一？\n答：二")];
  const view = render(<QuizPanel projectId="project" insights={insights} onDelete={async () => true} />);
  expect(screen.queryByText("北京")).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "我的答案" } });
  fireEvent.click(screen.getByRole("button", { name: "查看参考答案" }));
  expect(screen.getByText("北京")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "已掌握" }));
  fireEvent.click(screen.getByRole("tab", { name: "数学" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  view.unmount();
  render(<QuizPanel projectId="project" insights={insights} onDelete={async () => true} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("我的答案");
  expect(screen.getByRole("button", { name: "已掌握" }).getAttribute("aria-pressed")).toBe("true");
});

it("does not turn summaries into practice sets and handles malformed Q&A", () => {
  const view = render(<QuizPanel projectId="project" insights={[{ ...makeInsight("summary", "## 问：X\n答：Y"), builtinKey: "summary" }]} onDelete={async () => true} />);
  expect(screen.getByText("暂无题目")).toBeTruthy();
  view.rerender(<QuizPanel projectId="project" insights={[makeInsight("bad", "not a question")]} onDelete={async () => true} />);
  expect(screen.getByRole("status").textContent).toContain("未识别出完整题目");
});

it("deletes a question set through its tab action", async () => {
  let deleted = "";
  render(<QuizPanel projectId="project" insights={[makeInsight("one", "# 地理\n## 问：首都？\n答：北京")]} onDelete={async (id) => { deleted = id; return true; }} />);
  fireEvent.click(screen.getByRole("button", { name: "删除: 地理" }));
  expect(deleted).toBe("one");
});
