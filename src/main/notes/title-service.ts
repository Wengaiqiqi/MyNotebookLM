import { randomUUID } from "node:crypto";
import { appLanguageSchema, type AppLanguage } from "../../shared/settings";
import type { NoteDto } from "../../shared/notes";
import { NoteNotFoundError, type NoteRepository } from "./note-repository";
import type { RoutedGeneration } from "../models/routed-generation";

const MAX_INPUT_CODE_POINTS = 12_000;
const MAX_TITLE_CODE_POINTS = 80;
const TRUNCATION_MARKER: Record<AppLanguage, string> = {
  "zh-CN": "\n[内容已截断]",
  en: "\n[Content truncated]"
};

type GenerateTitleInput = Readonly<{
  projectId: string;
  noteId: string;
  locale: AppLanguage;
  profileId?: string;
  signal?: AbortSignal;
}>;

type TitleGeneration = Pick<RoutedGeneration, "generateRouted">;

function snapshotBody(body: string, locale: AppLanguage): string {
  const points = Array.from(body);
  if (points.length <= MAX_INPUT_CODE_POINTS) return body;
  const marker = Array.from(TRUNCATION_MARKER[locale]);
  return points.slice(0, Math.max(0, MAX_INPUT_CODE_POINTS - marker.length)).join("") + marker.join("");
}

function cleanTitle(value: string): string {
  let title = value.replace(/\s+/gu, " ").trim();
  const quotePairs: ReadonlyArray<readonly [string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]];
  for (const [open, close] of quotePairs) {
    if (title.startsWith(open) && title.endsWith(close) && title.length >= open.length + close.length) {
      title = title.slice(open.length, -close.length).trim();
      break;
    }
  }
  return Array.from(title).slice(0, MAX_TITLE_CODE_POINTS).join("");
}

function prompt(locale: AppLanguage, body: string): [{ role: "system"; content: string }, { role: "user"; content: string }] {
  return locale === "zh-CN"
    ? [
        { role: "system", content: "你是笔记标题助手。请只输出一个简洁、准确的标题，不要解释。" },
        { role: "user", content: `请根据以下笔记内容生成标题：\n\n${body}` }
      ]
    : [
        { role: "system", content: "You are a note title assistant. Output only one concise, accurate title without explanation." },
        { role: "user", content: `Generate a title from the following note content:\n\n${body}` }
      ];
}

export class TitleService {
  constructor(
    private readonly repository: Pick<NoteRepository, "get" | "update">,
    private readonly generation: TitleGeneration,
    private readonly createOperationId: () => string = randomUUID
  ) {}

  async generateTitle(input: GenerateTitleInput): Promise<NoteDto> {
    const locale = appLanguageSchema.parse(input.locale);
    const snapshot = this.repository.get(input.projectId, input.noteId);
    if (!snapshot || snapshot.deletedAt) throw new NoteNotFoundError(input.noteId);

    let generated = "";
    const messages = prompt(locale, snapshotBody(snapshot.body, locale));
    const request = {
      projectId: input.projectId,
      operationId: this.createOperationId(),
      model: "note-title",
      messages
    };
    for await (const event of this.generation.generateRouted("note-title", request, input.profileId, input.signal)) {
      if (event.type === "text-delta") generated += event.text;
    }

    const title = cleanTitle(generated);
    if (!title) return snapshot;
    return this.repository.update({
      projectId: input.projectId,
      id: input.noteId,
      title,
      body: snapshot.body,
      version: snapshot.version
    });
  }
}

export type { GenerateTitleInput };
