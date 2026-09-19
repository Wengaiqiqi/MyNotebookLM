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
  { key: "qa", language: "zh-CN", name: "选择题测验", appliesTo: "source", prompt: "请根据以下资料用中文生成一套用于互动答题练习的单项选择题，题目与答案必须有确切的资料依据，不得编造。\n\n输出规范：\n1. 第一行使用 Markdown 一级标题为题组命名（例如：# 测验名称）。\n2. 每道题目必须是单项选择题，严格使用以下格式：\n## 1. 题目内容\nA. 选项A内容\nB. 选项B内容\nC. 选项C内容\nD. 选项D内容\n正确答案：A\n解析：简明说明正确依据及资料出处。\n\n3. 必须提供且仅提供 A、B、C、D 四个互斥选项；“正确答案：”必须且只能是 A、B、C、D 中的一个字母。\n4. 每道题之间空一行。不要使用代码块代码围栏包裹输出。\n\n{{content}}" },
  { key: "qa", language: "en", name: "Quiz", appliesTo: "source", prompt: "Generate a practice set of multiple-choice questions grounded strictly in the source. Do not fabricate facts.\n\nOutput requirements:\n1. Start with a Markdown level-one title naming the quiz set (e.g., # Quiz Title).\n2. Every question must be a multiple-choice question using exactly this format:\n## 1. Question text\nA. Option A\nB. Option B\nC. Option C\nD. Option D\nAnswer: A\nExplanation: Concise explanation grounded strictly in the source text.\n\n3. Always provide exactly four options (A, B, C, D). The answer line must be exactly one letter (A, B, C, or D).\n4. Separate questions with a blank line. Do not wrap the output in a code fence.\n\n{{content}}" }
];

export const BUILTIN_TRANSFORMATIONS: readonly BuiltinTransformationDescriptor[] = Object.freeze(
  descriptors.map((descriptor) => Object.freeze(descriptor))
);

export const BUILT_IN_TRANSFORMATIONS = BUILTIN_TRANSFORMATIONS;

export function listBuiltinTransformations(): readonly BuiltinTransformationDescriptor[] {
  return BUILTIN_TRANSFORMATIONS.slice();
}

export const getBuiltinTransformations = listBuiltinTransformations;
