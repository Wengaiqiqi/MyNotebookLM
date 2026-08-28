import { transformationPromptSchema } from "../../shared/transformations";

export type TransformationTemplateValues = Readonly<{
  content?: string;
  sourceTitle?: string;
  projectName?: string;
  language?: string;
  source_title?: string;
  project_name?: string;
}>;

const placeholders = /\{\{(content|source_title|project_name|language)\}\}/g;

export function renderTransformationPrompt(template: string, values: TransformationTemplateValues = {}): string {
  const parsed = transformationPromptSchema.parse(template);
  const resolved: Record<string, string> = {
    content: values.content ?? "",
    source_title: values.sourceTitle ?? values.source_title ?? "",
    project_name: values.projectName ?? values.project_name ?? "",
    language: values.language ?? ""
  };
  return parsed.replace(placeholders, (_match, key: string) => resolved[key] ?? "");
}

export const renderTemplate = renderTransformationPrompt;
