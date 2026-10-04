import type { IpcMain } from "electron";
import { z } from "zod";
import { internalFailure, resultSchema, validationFailure } from "../../shared/app-errors";
import { conversationSchema } from "../../shared/chat";
import { MINDMAP_CHANNELS, mindMapDtoSchema, mindMapInputSchema, mindMapNodeInputSchema, mindMapReferenceInputSchema, mindMapSaveViewInputSchema } from "../../shared/mindmaps";
import { MindMapNotFoundError, type MindMapService } from "../notes/mindmap-service";
import type { CitationOpener } from "../chat/citation-opener";

export function registerMindMapHandlers(ipc: Pick<IpcMain, "handle" | "removeHandler">, service: MindMapService, opener: Pick<CitationOpener, "openChunk">): () => void {
  const handle = <I>(channel: string, schema: z.ZodType<I>, output: z.ZodType, call: (input: I) => unknown): void => {
    ipc.handle(channel, async (_event, raw: unknown) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return validationFailure();
      try {
        const value = await call(parsed.data);
        const candidate = value && typeof value === "object" && "ok" in value ? value : { ok: true, value };
        const result = resultSchema(output).safeParse(candidate);
        return result.success ? result.data : internalFailure();
      } catch (error) {
        return error instanceof MindMapNotFoundError ? { ok: false, error: { code: "NOT_FOUND", messageKey: "errors.notFound", recoverable: false } } : internalFailure();
      }
    });
  };
  handle(MINDMAP_CHANNELS.get, mindMapInputSchema, mindMapDtoSchema, (input) => service.get(input));
  handle(MINDMAP_CHANNELS.saveView, mindMapSaveViewInputSchema, z.undefined(), (input) => service.saveView(input));
  handle(MINDMAP_CHANNELS.conversation, mindMapNodeInputSchema, conversationSchema, (input) => service.conversation(input));
  handle(MINDMAP_CHANNELS.openReference, mindMapReferenceInputSchema, z.object({ opened: z.enum(["document", "url"]) }).strict(), (input) => {
    const reference = service.reference(input);
    return opener.openChunk({ projectId: input.projectId, chunkId: reference.chunkId });
  });
  return () => Object.values(MINDMAP_CHANNELS).forEach((channel) => ipc.removeHandler(channel));
}
