import { randomUUID } from "node:crypto";
import {
  createNoteInputSchema,
  createNoteLinkInputSchema,
  deleteNoteLinkInputSchema,
  noteDtoSchema,
  noteIdInputSchema,
  noteLinkDtoSchema,
  listNotesInputSchema,
  noteStateInputSchema,
  updateNoteInputSchema,
  type CreateNoteInput,
  type CreateNoteLinkInput,
  type DeleteNoteLinkInput,
  type NoteIdInput,
  type NoteDto,
  type NoteLinkDto,
  type UpdateNoteInput
} from "../../shared/notes";
import type { NoteRepository } from "./note-repository";
import type { GenerateTitleInput, TitleService } from "./title-service";

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export class NoteService {
  constructor(
    private readonly repository: NoteRepository,
    private readonly createId: () => string = randomUUID,
    private readonly titleService?: Pick<TitleService, "generateTitle">
  ) {}

  createNote(input: CreateNoteInput): NoteDto {
    const parsed = createNoteInputSchema.parse(input);
    return noteDtoSchema.parse(this.repository.create({
      id: this.createId(),
      projectId: parsed.projectId,
      title: parsed.title,
      body: normalizeMarkdown(parsed.body)
    }));
  }

  getNote(input: { projectId: string; id: string }): NoteDto | undefined {
    const parsed = noteIdInputSchema.parse(input);
    const note = this.repository.get(parsed.projectId, parsed.id);
    return note ? noteDtoSchema.parse(note) : undefined;
  }

  listNotes(input: string | { projectId: string; includeArchived?: boolean }): NoteDto[] {
    const parsed = listNotesInputSchema.parse(typeof input === "string" ? { projectId: input } : input);
    return noteDtoSchema.array().parse(this.repository.list(parsed.projectId, parsed.includeArchived === undefined ? {} : { includeArchived: parsed.includeArchived }));
  }

  updateNote(input: UpdateNoteInput): NoteDto {
    const parsed = updateNoteInputSchema.parse(input);
    return noteDtoSchema.parse(this.repository.update({ ...parsed, body: normalizeMarkdown(parsed.body) }));
  }

  generateTitle(input: GenerateTitleInput): Promise<NoteDto> {
    if (!this.titleService) throw new Error("Title service is not configured");
    return this.titleService.generateTitle(input);
  }

  archiveNote(input: { projectId: string; id: string; version: number }): NoteDto {
    const parsed = noteStateInputSchema.parse(input);
    return noteDtoSchema.parse(this.repository.archive(parsed.projectId, parsed.id, parsed.version));
  }

  restoreNote(input: { projectId: string; id: string; version: number }): NoteDto {
    const parsed = noteStateInputSchema.parse(input);
    return noteDtoSchema.parse(this.repository.restore(parsed.projectId, parsed.id, parsed.version));
  }

  deleteNote(input: { projectId: string; id: string; version: number }): void {
    const parsed = noteStateInputSchema.parse(input);
    this.repository.remove(parsed.projectId, parsed.id, parsed.version);
  }

  createLink(input: CreateNoteLinkInput): NoteLinkDto {
    const parsed = createNoteLinkInputSchema.parse(input);
    return noteLinkDtoSchema.parse(this.repository.createLink({
      id: this.createId(),
      projectId: parsed.projectId,
      noteId: parsed.noteId,
      targetProjectId: parsed.targetProjectId ?? null,
      sourceId: parsed.sourceId ?? null,
      messageId: parsed.messageId ?? null,
      citationId: parsed.citationId ?? null
    }));
  }

  listLinks(input: NoteIdInput): NoteLinkDto[] {
    const parsed = noteIdInputSchema.parse(input);
    return noteLinkDtoSchema.array().parse(this.repository.listLinks(parsed.projectId, parsed.id));
  }

  deleteLink(input: DeleteNoteLinkInput): void {
    const parsed = deleteNoteLinkInputSchema.parse(input);
    this.repository.removeLink(parsed.projectId, parsed.noteId, parsed.linkId);
  }
}
