import Database from "better-sqlite3";
import { citationLocatorSchema, type CitationDto } from "../../shared/chat";
import type { ParsedCitations, RetrievedCitation } from "./citation-parser";
import { citationClaim, relevantSourceExcerpt } from "./citation-relevance";

const QUOTE_LIMIT = 240;

export type CitationRow = Readonly<{
  id: string;
  label: string;
  sourceId: string;
  sourceChunkId: string;
  sourceDisplayName: string;
  sourceKind: string;
  locator: unknown;
  quote?: string;
  start: number;
  createdAt: string;
}>;

/**
 * Builds the citation rows for one answer without writing them, so the caller
 * can commit text, citations, usage, and runtime in a single transaction.
 */
export function buildCitationRows(
  input: {
    messageId: string;
    parsed: ParsedCitations;
    retrievals: Record<string, RetrievedCitation>;
  },
  createdAt: string
): CitationRow[] {
  return input.parsed.citations.map((c) => {
    const match = input.retrievals[c.label];
    if (!match) throw new Error(`unknown citation label ${c.label}`);
    return {
      id: `${input.messageId}:${c.label}:${c.start}`,
      label: c.label,
      sourceId: match.sourceId,
      sourceChunkId: match.chunkId,
      sourceDisplayName: match.sourceDisplayName,
      sourceKind: match.sourceKind,
      locator: match.locator,
      start: c.start,
      createdAt,
      ...(match.text ? { quote: relevantSourceExcerpt(match.text, citationClaim(input.parsed.content, c.start), QUOTE_LIMIT) } : {})
    };
  });
}

// Persists the complete citation set for one answer atomically. Replacing the
// set is required for continuation because labels and offsets are recomputed
// against the merged answer.
export function persistParsedCitations(
  db: InstanceType<typeof Database>,
  input: {
    projectId: string;
    messageId: string;
    parsed: ParsedCitations;
    retrievals: Record<string, RetrievedCitation>;
  },
): CitationDto[] {
  const owned = db.prepare("SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=?").get(input.messageId, input.projectId);
  if (!owned) throw new Error("message not found");
  const createdAt = new Date().toISOString();
  const citations = buildCitationRows(input, createdAt);
  db.transaction(() => {
    db.prepare("DELETE FROM message_citations WHERE message_id=?").run(input.messageId);
    const insert = db.prepare("INSERT INTO message_citations(id,message_id,label,source_id,source_chunk_id,source_display_name,source_kind,locator_json,quote,created_at,start) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    for (const citation of citations) {
      insert.run(
        citation.id,
        input.messageId,
        citation.label,
        citation.sourceId,
        citation.sourceChunkId,
        citation.sourceDisplayName,
        citation.sourceKind,
        JSON.stringify(citation.locator),
        citation.quote ?? null,
        citation.createdAt,
        citation.start
      );
    }
  })();
  return citations.map((citation) => ({
    id: citation.id,
    label: citation.label,
    sourceId: citation.sourceId,
    sourceChunkId: citation.sourceChunkId,
    sourceDisplayName: citation.sourceDisplayName,
    sourceKind: citation.sourceKind,
    locator: citationLocatorSchema.parse(citation.locator),
    ...(citation.quote === undefined ? {} : { quote: citation.quote })
  }));
}
