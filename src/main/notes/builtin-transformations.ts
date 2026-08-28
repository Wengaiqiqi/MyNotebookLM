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
  { key: "qa", language: "zh-CN", name: "问答", appliesTo: "source", prompt: "请根据以下资料用中文生成问题与答案，答案必须有资料依据：\n\n{{content}}" },
  { key: "qa", language: "en", name: "Q&A", appliesTo: "source", prompt: "Generate grounded questions and answers about the following source in English:\n\n{{content}}" }
];

export const BUILTIN_TRANSFORMATIONS: readonly BuiltinTransformationDescriptor[] = Object.freeze(
  descriptors.map((descriptor) => Object.freeze(descriptor))
);

export const BUILT_IN_TRANSFORMATIONS = BUILTIN_TRANSFORMATIONS;

export function listBuiltinTransformations(): readonly BuiltinTransformationDescriptor[] {
  return BUILTIN_TRANSFORMATIONS.slice();
}

export const getBuiltinTransformations = listBuiltinTransformations;
