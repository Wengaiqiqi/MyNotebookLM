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
    .toMatchObject([{ question: "首都？", answer: "北京" }, { question: "日期？", answer: "六月。" }, { question: "Why?", answer: "Because.\nMore detail." }]);
  expect(parseQuiz("A plain summary.")).toEqual([]);
  expect(parseQuiz("1. **问：日期？**\n**答：**六月。\n## 问：解释 **重点**\n答：保留格式。"))
    .toMatchObject([{ question: "日期？", answer: "六月。" }, { question: "解释 **重点**", answer: "保留格式。" }]);
});

it("parses multiple-choice quiz questions and cleans stray markdown artifacts", () => {
  const markdown = `# 六级核心考点测验

## 1. 2026年上半年英语六级笔试什么时候举行？ **
A. 2026年6月13日
B. 2026年6月14日
C. 2026年12月12日
D. 2026年12月13日
正确答案：A
解析：根据资料，考试时间为2026年6月13日。

## 2. 考试报到时间是几点？
A. 13:00
B. 14:00
C. 15:00
D. 15:30
正确答案：B
解析：准考证载明14:00报到。`;

  const parsed = parseQuiz(markdown);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]!.question).toBe("2026年上半年英语六级笔试什么时候举行？");
  expect(parsed[0]!.options).toHaveLength(4);
  expect(parsed[0]!.options[0]).toEqual({ key: "A", text: "2026年6月13日" });
  expect(parsed[0]!.correctAnswer).toBe("A");
  expect(parsed[0]!.explanation).toBe("根据资料，考试时间为2026年6月13日。");

  expect(parsed[1]!.question).toBe("考试报到时间是几点？");
  expect(parsed[1]!.correctAnswer).toBe("B");
});

it("interacts with multiple-choice quiz providing instant feedback and explanation", () => {
  const mcInsight = makeInsight("mc-set", `# 测验
## 1. 英语六级考试时间？
A. 6月13日
B. 6月14日
C. 12月12日
D. 12月13日
正确答案：A
解析：官方资料明确为6月13日。

## 2. 报到时间？
A. 13:00
B. 14:00
C. 15:00
D. 16:00
正确答案：B
解析：14:00报到。`);

  render(<QuizPanel projectId="project" insights={[mcInsight]} onDelete={async () => true} />);
  expect(screen.getByText("英语六级考试时间？")).toBeTruthy();
  expect(screen.getByText("6月13日")).toBeTruthy();
  expect(screen.getByText("报到时间？")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /下一题|上一题|单题聚焦/ })).toBeNull();

  // Pick wrong option B
  const optB = screen.getByRole("radio", { name: /6月14日/ });
  fireEvent.click(optB);

  // Expect incorrect feedback and showing correct answer
  expect(screen.getByText("回答错误")).toBeTruthy();
  expect(screen.getByText(/官方资料明确为6月13日/)).toBeTruthy();

  // Pick correct option B
  const q2OptB = screen.getByRole("radio", { name: /14:00/ });
  fireEvent.click(q2OptB);
  expect(screen.getByText("回答正确")).toBeTruthy();

  const summaryButton = screen.getByRole("button", { name: /查看测试成绩/ });
  expect(summaryButton.closest(".quiz-list-wrapper")).not.toBeNull();

  // View summary
  fireEvent.click(summaryButton);
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByText("答对 1 / 2 题")).toBeTruthy();
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
