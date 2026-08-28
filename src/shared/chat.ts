import { z } from "zod";
import { sourceLocatorSchema } from "./sources";
export const messageStateSchema=z.enum(["streaming","completed","cancelled","failed"]);
export const citationLabelSchema=z.string().regex(/^S(?:[1-9]|1[0-2])$/);
// Chat citations persist the source chunk locator verbatim; validating against the
// same schema that governs chunk locators prevents drift (real PDFs carry endPage).
export const citationLocatorSchema=sourceLocatorSchema;
const usageSchema=z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),totalTokens:z.number().int().nonnegative()});
export const conversationSchema=z.object({id:z.string(),projectId:z.string(),title:z.string(),createdAt:z.string(),updatedAt:z.string(),deletedAt:z.string().nullable(),archivedAt:z.string().nullable()});
export const citationSchema=z.object({id:z.string(),label:citationLabelSchema,sourceId:z.string(),sourceChunkId:z.string().nullable(),sourceDisplayName:z.string(),sourceKind:z.string(),locator:citationLocatorSchema,quote:z.string().optional()});
export const messageSchema=z.object({id:z.string(),conversationId:z.string(),sequence:z.number(),role:z.enum(["user","assistant"]),content:z.string(),state:messageStateSchema,replyToMessageId:z.string().nullable(),supersedesMessageId:z.string().nullable(),superseded:z.boolean(),provider:z.string().nullable(),profileId:z.string().nullable(),model:z.string().nullable(),usage:usageSchema.nullable(),errorCode:z.string().nullable(),completionReason:z.string().nullable(),createdAt:z.string(),updatedAt:z.string(),citations:z.array(citationSchema)});
export const chatStreamEventSchema=z.discriminatedUnion("type",[z.object({type:z.literal("delta"),messageId:z.string(),text:z.string()}),z.object({type:z.literal("completed"),messageId:z.string(),message:messageSchema}),z.object({type:z.literal("failed"),messageId:z.string(),error:z.object({code:z.string(),messageKey:z.string(),recoverable:z.boolean()})})]);
export type ConversationDto=z.infer<typeof conversationSchema>; export type CitationDto=z.infer<typeof citationSchema>; export type MessageDto=z.infer<typeof messageSchema>; export type ChatStreamEvent=z.infer<typeof chatStreamEventSchema>;
