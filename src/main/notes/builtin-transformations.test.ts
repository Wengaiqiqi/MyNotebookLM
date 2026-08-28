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
          "name": "问答",
          "prompt": "请根据以下资料用中文生成问题与答案，答案必须有资料依据：

      {{content}}",
        },
        {
          "appliesTo": "source",
          "key": "qa",
          "language": "en",
          "name": "Q&A",
          "prompt": "Generate grounded questions and answers about the following source in English:

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
