import Database from "better-sqlite3";
import type { CitationDto } from "../../shared/chat";
import type { ParsedCitations, RetrievedCitation } from "./citation-parser";
import { ConversationRepository } from "./conversation-repository";

// Persists parsed citation rows aligned with Task 1 message_citations / CitationDto.
// ponytail: no batching/transaction wrapper beyond repo.addCitation, sizes are tiny.
export function persistParsedCitations(
  db: InstanceType<typeof Database>,
  input: {
    projectId: string;
    messageId: string;
    parsed: ParsedCitations;
    retrievals: Record<string, RetrievedCitation>;
  },
): CitationDto[] {
  const createdAt = new Date().toISOString();
  const repo = new ConversationRepository(db);
  return input.parsed.citations.map((c) => {
    const match = input.retrievals[c.label];
    if (!match) throw new Error(`unknown citation label ${c.label}`);
    return repo.addCitation({
      projectId: input.projectId,
      messageId: input.messageId,
      id: `${input.messageId}:${c.label}:${c.start}`,
      label: c.label,
      sourceId: match.sourceId,
      sourceChunkId: match.chunkId,
      sourceDisplayName: match.sourceDisplayName,
      sourceKind: match.sourceKind,
      locator: match.locator,
      createdAt,
      start: c.start,
    });
  });
}
