import { describe, expect, it } from "vitest";
import { BUILTIN_TRANSFORMATIONS, listBuiltinTransformations } from "./builtin-transformations";

describe("built-in transformations", () => {
  it("contains immutable bilingual summary, key-points and Q&A descriptors", () => {
    expect(listBuiltinTransformations()).toMatchInlineSnapshot(`
      [
        {
          "appliesTo": "source",
          "key": "summary",
          "language": "zh-CN",
          "name": "摘要",
          "prompt": "请用中文概括以下资料，保留关键事实和结论：

      {{content}}",
        },
        {
          "appliesTo": "source",
          "key": "summary",
          "language": "en",
          "name": "Summary",
          "prompt": "Summarize the following source in English, preserving key facts and conclusions:

      {{content}}",
        },
        {
          "appliesTo": "source",
          "key": "key-points",
          "language": "zh-CN",
          "name": "要点",
          "prompt": "请用中文提取以下资料的关键要点，使用简洁项目符号：

      {{content}}",
        },
        {
          "appliesTo": "source",
          "key": "key-points",
          "language": "en",
          "name": "Key points",
          "prompt": "Extract the key points from the following source in concise bullet points:

      {{content}}",
        },
        {
          "appliesTo": "source",
          "key": "qa",
          "language": "zh-CN",
          "name": "选择题测验",
          "prompt": "请根据以下资料用中文生成一套用于互动答题练习的单项选择题，题目与答案必须有确切的资料依据，不得编造。

      输出规范：
      1. 第一行使用 Markdown 一级标题为题组命名（例如：# 测验名称）。
      2. 每道题目必须是单项选择题，严格使用以下格式：
      ## 1. 题目内容
      A. 选项A内容
      B. 选项B内容
      C. 选项C内容
      D. 选项D内容
      正确答案：A
      解析：简明说明正确依据及资料出处。

      3. 必须提供且仅提供 A、B、C、D 四个互斥选项；“正确答案：”必须且只能是 A、B、C、D 中的一个字母。
      4. 每道题之间空一行。不要使用代码块代码围栏包裹输出。

      {{content}}",
        },
        {
          "appliesTo": "source",
          "key": "qa",
          "language": "en",
          "name": "Quiz",
          "prompt": "Generate a practice set of multiple-choice questions grounded strictly in the source. Do not fabricate facts.

      Output requirements:
      1. Start with a Markdown level-one title naming the quiz set (e.g., # Quiz Title).
      2. Every question must be a multiple-choice question using exactly this format:
      ## 1. Question text
      A. Option A
      B. Option B
      C. Option C
      D. Option D
      Answer: A
      Explanation: Concise explanation grounded strictly in the source text.

      3. Always provide exactly four options (A, B, C, D). The answer line must be exactly one letter (A, B, C, or D).
      4. Separate questions with a blank line. Do not wrap the output in a code fence.

      {{content}}",
        },
      ]
    `);
    expect(Object.isFrozen(BUILTIN_TRANSFORMATIONS)).toBe(true);
    expect(BUILTIN_TRANSFORMATIONS.every(Object.isFrozen)).toBe(true);
  });

  it("returns a fresh array while preserving immutable descriptors", () => {
    const first = listBuiltinTransformations();
    const second = listBuiltinTransformations();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
