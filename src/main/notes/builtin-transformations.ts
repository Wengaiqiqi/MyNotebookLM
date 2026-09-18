import type { AppLanguage } from "../../shared/settings";
import type { TransformationAppliesTo } from "../../shared/transformations";

export type BuiltinTransformationKey = "summary" | "key-points" | "qa";

export type BuiltinTransformationDescriptor = Readonly<{
  key: BuiltinTransformationKey;
  language: AppLanguage;
  name: string;
  appliesTo: TransformationAppliesTo;
  prompt: string;
}>;

const descriptors: BuiltinTransformationDescriptor[] = [
  { key: "summary", language: "zh-CN", name: "摘要", appliesTo: "source", prompt: "请用中文概括以下资料，保留关键事实和结论：\n\n{{content}}" },
  { key: "summary", language: "en", name: "Summary", appliesTo: "source", prompt: "Summarize the following source in English, preserving key facts and conclusions:\n\n{{content}}" },
  { key: "key-points", language: "zh-CN", name: "要点", appliesTo: "source", prompt: "请用中文提取以下资料的关键要点，使用简洁项目符号：\n\n{{content}}" },
  { key: "key-points", language: "en", name: "Key points", appliesTo: "source", prompt: "Extract the key points from the following source in concise bullet points:\n\n{{content}}" },
  { key: "qa", language: "zh-CN", name: "问答", appliesTo: "source", prompt: "请根据以下资料用中文生成一套用于互动练习的问题与参考答案，答案必须有资料依据，不得编造。第一行用 Markdown 一级标题给题组命名。每道题严格使用以下格式，问与答各自独占一行，可包含多行正文：\n## 问：题目内容\n答：参考答案\n不要使用代码围栏包裹输出。\n\n{{content}}" },
  { key: "qa", language: "en", name: "Q&A", appliesTo: "source", prompt: "Generate a practice set of grounded questions and reference answers from the source. Start with a Markdown level-one title. Use exactly this format for each question, with question and answer on separate lines (their bodies may span multiple lines):\n## Q: Question text\nA: Reference answer\nDo not wrap the output in a code fence.\n\n{{content}}" }
];

export const BUILTIN_TRANSFORMATIONS: readonly BuiltinTransformationDescriptor[] = Object.freeze(
  descriptors.map((descriptor) => Object.freeze(descriptor))
);

export const BUILT_IN_TRANSFORMATIONS = BUILTIN_TRANSFORMATIONS;

export function listBuiltinTransformations(): readonly BuiltinTransformationDescriptor[] {
  return BUILTIN_TRANSFORMATIONS.slice();
}

export const getBuiltinTransformations = listBuiltinTransformations;
