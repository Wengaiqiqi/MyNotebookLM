import type { IpcMain } from "electron";
import { z } from "zod";
import { internalFailure, resultSchema, validationFailure } from "../../shared/app-errors";
import { NOTE_CHANNELS } from "../../shared/ipc";
import {
  createNoteInputSchema, createNoteLinkInputSchema, deleteNoteLinkInputSchema, generateNoteTitleInputSchema,
  listNotesInputSchema, noteDtoSchema, noteIdInputSchema, noteLinkDtoSchema, noteStateInputSchema,
  updateNoteInputSchema
} from "../../shared/notes";
import type { NoteService } from "../notes/note-service";

type Ipc = Pick<IpcMain, "handle" | "removeHandler">;
type Service = Pick<NoteService, "createNote" | "getNote" | "listNotes" | "updateNote" | "archiveNote" | "restoreNote" | "deleteNote" | "createLink" | "listLinks" | "deleteLink" | "generateTitle">;
const empty = z.undefined();
const noteResult = resultSchema(noteDtoSchema);
const nullableNoteResult = resultSchema(noteDtoSchema.nullable());
const notesResult = resultSchema(noteDtoSchema.array());
const linksResult = resultSchema(noteLinkDtoSchema.array());
const linkResult = resultSchema(noteLinkDtoSchema);
const voidResult = resultSchema(empty);

function errorResult(reason: unknown): ReturnType<typeof internalFailure> {
  const name = reason instanceof Error ? reason.name : "";
  if (name.includes("VersionConflict") || name.includes("LinkConflict")) return { ok: false, error: { code: "CONFLICT", messageKey: "errors.conflict", recoverable: true } };
  if (name.includes("NotFound")) return { ok: false, error: { code: "NOT_FOUND", messageKey: "errors.notFound", recoverable: false } };
  if (name.includes("Unavailable") || name.includes("ProjectMismatch") || name.includes("TargetNotFound")) return validationFailure();
  return internalFailure();
}

async function safe<I>(schema: z.ZodType<I>, output: z.ZodType, raw: unknown, call: (value: I) => unknown): Promise<unknown> {
  const parsed = schema.safeParse(raw); if (!parsed.success) return validationFailure();
  try { const value = await call(parsed.data); const candidate = value && typeof value === "object" && "ok" in value ? value : { ok: true, value }; const result = output.safeParse(candidate); return result.success ? result.data : internalFailure(); } catch (reason) { return errorResult(reason); }
}

export function registerNoteHandlers(ipc: Ipc, service: Service): () => void {
  ipc.handle(NOTE_CHANNELS.create, (_event, input) => safe(createNoteInputSchema, noteResult, input, service.createNote.bind(service)));
  ipc.handle(NOTE_CHANNELS.get, (_event, input) => safe(noteIdInputSchema, nullableNoteResult, input, (value) => service.getNote(value) ?? null));
  ipc.handle(NOTE_CHANNELS.list, (_event, input) => safe(listNotesInputSchema, notesResult, input, (value) => service.listNotes(value as never)));
  ipc.handle(NOTE_CHANNELS.update, (_event, input) => safe(updateNoteInputSchema, noteResult, input, service.updateNote.bind(service)));
  ipc.handle(NOTE_CHANNELS.archive, (_event, input) => safe(noteStateInputSchema, noteResult, input, service.archiveNote.bind(service)));
  ipc.handle(NOTE_CHANNELS.restore, (_event, input) => safe(noteStateInputSchema, noteResult, input, service.restoreNote.bind(service)));
  ipc.handle(NOTE_CHANNELS.delete, (_event, input) => safe(noteStateInputSchema, voidResult, input, service.deleteNote.bind(service)));
  ipc.handle(NOTE_CHANNELS.createLink, (_event, input) => safe(createNoteLinkInputSchema, linkResult, input, service.createLink.bind(service)));
  ipc.handle(NOTE_CHANNELS.listLinks, (_event, input) => safe(noteIdInputSchema, linksResult, input, service.listLinks.bind(service)));
  ipc.handle(NOTE_CHANNELS.deleteLink, (_event, input) => safe(deleteNoteLinkInputSchema, voidResult, input, service.deleteLink.bind(service)));
  ipc.handle(NOTE_CHANNELS.generateTitle, (_event, input) => safe(generateNoteTitleInputSchema, noteResult, input, (value) => service.generateTitle(value as never)));
  const channels = Object.values(NOTE_CHANNELS);
  return () => channels.forEach((channel) => ipc.removeHandler(channel));
}
