import { z } from "zod";

export const sourceKindSchema = z.enum([
  "text",
  "markdown",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "url"
]);

export const sourceStatusSchema = z.enum([
  "active",
  "deleting",
  "deleted"
]);

export const sourceRevisionStateSchema = z.enum([
  "pending",
  "parsing",
  "awaiting_embedding",
  "ready",
  "failed"
]);

export const locatorKindSchema = z.enum([
  "page",
  "slide",
  "sheet",
  "cell",
  "row",
  "heading",
  "paragraph",
  "section",
  "offset"
]);

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

export const sourceLocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    page: positiveInteger,
    endPage: positiveInteger.optional()
  }).strict().refine((value) => value.endPage === undefined || value.endPage >= value.page, {
    message: "endPage must be >= page",
    path: ["endPage"]
  }),
  z.object({
    kind: z.literal("slide"),
    slide: positiveInteger,
    endSlide: positiveInteger.optional()
  }).strict().refine((value) => value.endSlide === undefined || value.endSlide >= value.slide, {
    message: "endSlide must be >= slide",
    path: ["endSlide"]
  }),
  z.object({
    kind: z.literal("sheet"),
    sheet: z.string().trim().min(1)
  }).strict(),
  z.object({
    kind: z.literal("cell"),
    sheet: z.string().trim().min(1),
    cellRef: z.string().trim().min(1)
  }).strict(),
  z.object({
    kind: z.literal("row"),
    sheet: z.string().trim().min(1),
    startRow: positiveInteger,
    endRow: positiveInteger
  }).strict().refine((value) => value.endRow >= value.startRow, {
    message: "endRow must be >= startRow",
    path: ["endRow"]
  }),
  z.object({
    kind: z.literal("heading"),
    depth: nonNegativeInteger,
    headingPath: z.string().trim().min(1)
  }).strict(),
  z.object({
    kind: z.literal("paragraph"),
    paragraph: positiveInteger,
    endParagraph: positiveInteger.optional()
  }).strict().refine((value) => value.endParagraph === undefined || value.endParagraph >= value.paragraph, {
    message: "endParagraph must be >= paragraph",
    path: ["endParagraph"]
  }),
  z.object({
    kind: z.literal("section"),
    sectionPath: z.string().trim().min(1),
    url: z.string().url()
  }).strict(),
  z.object({
    kind: z.literal("offset"),
    start: nonNegativeInteger,
    end: positiveInteger
  }).strict().refine((value) => value.end > value.start, {
    message: "end must be greater than start",
    path: ["end"]
  })
]);

export const sourceDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: sourceKindSchema,
  displayName: z.string().trim().min(1).max(255),
  status: sourceStatusSchema,
  currentRevisionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable()
  ,locator: z.string().trim().min(1).optional()
  ,currentRevisionState: sourceRevisionStateSchema.optional()
}).strict();

export const sourceRevisionDtoSchema = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  originalPath: z.string().trim().min(1),
  storedPath: z.string().trim().min(1),
  sourceHash: z.string().trim().min(1),
  locatorKind: locatorKindSchema,
  chunkingVersion: z.string().trim().min(1).max(100),
  state: sourceRevisionStateSchema,
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable()
}).strict();

export const sourceChunkDtoSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  ordinal: nonNegativeInteger,
  text: z.string(),
  locator: sourceLocatorSchema,
  contentHash: z.string().trim().min(1)
}).strict();

export type SourceKind = z.infer<typeof sourceKindSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export type SourceRevisionState = z.infer<typeof sourceRevisionStateSchema>;
export type LocatorKind = z.infer<typeof locatorKindSchema>;
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;
export type SourceDto = z.infer<typeof sourceDtoSchema>;
export type SourceRevisionDto = z.infer<typeof sourceRevisionDtoSchema>;
export type SourceChunkDto = z.infer<typeof sourceChunkDtoSchema>;
