import { z } from "zod";

export const noteBodySchema = z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= 2 * 1024 * 1024,
  "Note body must be at most 2 MiB"
);
export const noteTitleSchema = z.string().trim().min(1).max(200);

const noteFieldsSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: noteTitleSchema,
  body: noteBodySchema,
  version: z.number().int().positive(),
  archivedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

export const noteDtoSchema = noteFieldsSchema;
export const createNoteInputSchema = z.object({
  projectId: z.uuid(),
  title: noteTitleSchema,
  body: noteBodySchema
}).strict();
export const updateNoteInputSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid(),
  title: noteTitleSchema,
  body: noteBodySchema,
  version: z.number().int().positive()
}).strict();
export const noteIdInputSchema = z.object({ projectId: z.uuid(), id: z.uuid() }).strict();

const noteLinkTargetSchema = z.object({
  sourceId: z.uuid().nullable().optional(),
  messageId: z.uuid().nullable().optional(),
  citationId: z.uuid().nullable().optional()
}).strict().refine(
  (value) => [value.sourceId, value.messageId, value.citationId].filter((id) => id != null).length === 1,
  "A note link must target exactly one source, message or citation"
);

export const noteLinkDtoSchema = z.object({
  id: z.uuid(),
  noteId: z.uuid(),
  sourceId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  citationId: z.uuid().nullable(),
  createdAt: z.iso.datetime()
}).strict();
export const createNoteLinkInputSchema = z.object({
  projectId: z.uuid(),
  noteId: z.uuid()
}).merge(noteLinkTargetSchema).strict();
export const deleteNoteLinkInputSchema = z.object({
  projectId: z.uuid(),
  noteId: z.uuid(),
  linkId: z.uuid()
}).strict();

export type NoteDto = z.infer<typeof noteDtoSchema>;
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>;
export type NoteIdInput = z.infer<typeof noteIdInputSchema>;
export type NoteLinkDto = z.infer<typeof noteLinkDtoSchema>;
export type CreateNoteLinkInput = z.infer<typeof createNoteLinkInputSchema>;
export type DeleteNoteLinkInput = z.infer<typeof deleteNoteLinkInputSchema>;
