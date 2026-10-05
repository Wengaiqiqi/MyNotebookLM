import { z } from "zod";

export interface MindMapNode {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  refs: string[];
  children: MindMapNode[];
}

const mindMapNodeSchema: z.ZodType<MindMapNode> = z.lazy(() => z.object({
  id: z.string().min(1).max(128), title: z.string().trim().min(1).max(200),
  summary: z.string().max(8000), keyPoints: z.array(z.string().max(2000)).max(50),
  refs: z.array(z.string().max(128)).max(256), children: z.array(mindMapNodeSchema).max(100)
}).strict());

export const mindMapDocumentSchema = z.object({ version: z.literal(1), root: mindMapNodeSchema }).strict();
export type MindMapDocument = z.infer<typeof mindMapDocumentSchema>;
export const mindMapViewSchema = z.object({
  selectedNodeId: z.string().max(128).nullable().default(null), focused: z.boolean().default(false),
  collapsedIds: z.array(z.string().max(128)).max(2000).default([]),
  scale: z.number().finite().min(0.001).max(3).default(1),
  panX: z.number().finite().default(0), panY: z.number().finite().default(0),
  panelWidth: z.number().finite().min(300).max(800).default(410),
  tab: z.enum(["details", "chat"]).default("details")
}).strict();
export type MindMapView = z.infer<typeof mindMapViewSchema>;
export const mindMapReferenceSchema = z.object({
  chunkId: z.string(), sourceId: z.string(), revisionId: z.string(), sourceTitle: z.string(),
  text: z.string(), locatorSummary: z.string()
}).strict();
export type MindMapReference = z.infer<typeof mindMapReferenceSchema>;
export const mindMapDtoSchema = z.object({
  insightId: z.uuid(), projectId: z.uuid(), document: mindMapDocumentSchema,
  references: z.array(mindMapReferenceSchema), sourceCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().positive(), view: mindMapViewSchema
}).strict();
export type MindMapDto = z.infer<typeof mindMapDtoSchema>;
export const mindMapInputSchema = z.object({ projectId: z.uuid(), insightId: z.uuid() }).strict();
export const mindMapNodeInputSchema = mindMapInputSchema.extend({ nodeId: z.string().min(1).max(128) });
export const mindMapReferenceInputSchema = mindMapNodeInputSchema.extend({ chunkId: z.string().min(1).max(128) });
export const mindMapSaveViewInputSchema = mindMapInputSchema.extend({ view: mindMapViewSchema });
export const MINDMAP_CHANNELS = {
  get: "mindmaps:v1:get", saveView: "mindmaps:v1:save-view",
  conversation: "mindmaps:v1:conversation", openReference: "mindmaps:v1:open-reference"
} as const;

export function flattenMindMap(root: MindMapNode): MindMapNode[] {
  const result: MindMapNode[] = [];
  const visit = (node: MindMapNode): void => { result.push(node); node.children.forEach(visit); };
  visit(root);
  return result;
}
export function mindMapPath(root: MindMapNode, id: string): MindMapNode[] {
  if (root.id === id) return [root];
  for (const child of root.children) {
    const path = mindMapPath(child, id);
    if (path.length) return [root, ...path];
  }
  return [];
}

export function mindMapMarkdown(document: MindMapDocument): string {
  const lines: string[] = [];
  const visit = (node: MindMapNode, depth: number): void => {
    lines.push(`${"#".repeat(Math.min(6, depth + 1))} ${node.title}`, "");
    if (node.summary) lines.push(node.summary, "");
    if (node.keyPoints.length) lines.push(...node.keyPoints.map((point) => `- ${point}`), "");
    node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(document.root, 0);
  return lines.join("\n");
}
