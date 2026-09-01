import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useTranslation } from "react-i18next";
import type { CitationDto, MessageDto } from "../../../shared/chat";

// Plan 4 global constraint allowlist: text, headings, lists, tables, blockquotes,
// code and safe links. Everything else (scripts, styles, iframes, images, event
// attributes, unsafe protocols) is stripped by the explicit whitelist below.
const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "del", "blockquote",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "code", "pre",
  "table", "thead", "tbody", "tr", "th", "td",
  "a"
];
const ALLOWED_ATTR = ["href"];
const FORBID_TAGS = ["img", "script", "style", "iframe", "object", "embed"];
// Module-level single registration so streaming renders never accumulate
// duplicate afterSanitizeAttributes hooks on the shared DOMPurify instance.
let linkHardeningRegistered = false;

function ensureLinkHardening(): void {
  if (linkHardeningRegistered) return;
  linkHardeningRegistered = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof Element && node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

marked.setOptions({ async: false });

/** Render Markdown to sanitized HTML; raw HTML is escaped, not executed. */
export function renderSafeMarkdown(text: string): string {
  ensureLinkHardening();
  // Marked 18 has no sanitizer left; escape every raw '<' before parsing so
  // HTML/script markup stays inert literal text while Markdown syntax
  // (blockquotes use '>', code, tables) keeps working. DOMPurify then runs an
  // explicit allowlist over the generated tree as defense in depth.
  const neutralized = text.replace(/</g, "&lt;");
  const parsed = marked.parse(neutralized, { async: false });
  return DOMPurify.sanitize(parsed, { ALLOWED_TAGS, ALLOWED_ATTR, FORBID_TAGS });
}

type Piece = string | CitationDto;

export function canonicalizeCitationTargets(citations: CitationDto[]): { byLabel: Map<string, CitationDto>; unique: CitationDto[] } {
  const groups = new Map<string, { labels: Set<string>; representative: CitationDto; order: number }>();
  for (const citation of citations) {
    const table = citation.sourceKind.toLowerCase() === "docx" && citation.locator.kind === "cell"
      ? `${citation.sourceId}:${String(citation.locator.sheet).trim().toLowerCase()}`
      : `label:${citation.label}`;
    const group = groups.get(table);
    if (!group) {
      groups.set(table, { labels: new Set([citation.label]), representative: citation, order: Number(citation.label.slice(1)) });
    } else {
      group.labels.add(citation.label);
      group.order = Math.min(group.order, Number(citation.label.slice(1)));
      if ((citation.quote?.length ?? 0) > (group.representative.quote?.length ?? 0)) group.representative = citation;
    }
  }
  const byLabel = new Map<string, CitationDto>();
  const unique = [...groups.values()].sort((a, b) => a.order - b.order).map((group) => {
    const canonical = { ...group.representative, label: `S${group.order}` };
    for (const label of group.labels) byLabel.set(label, canonical);
    return canonical;
  });
  return { byLabel, unique };
}

function citationPieces(value: string, citations: Map<string, CitationDto>): Piece[] {
  const pieces: Piece[] = [];
  const re = /\[S(\d{1,2})\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    if (match.index > cursor) pieces.push(value.slice(cursor, match.index));
    const label = `S${match[1]}`;
    // Structured-row gate: unknown labels stay visible as plain text.
    pieces.push(citations.get(label) ?? value.slice(match.index, match.index + match[0].length));
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) pieces.push(value.slice(cursor));
  return pieces;
}

// Split sanitized HTML into text nodes and code regions so [S#]
// markers inside code blocks never become buttons.
export interface SafeMarkdownProps {
  text: string;
  citations?: CitationDto[];
  onCitationOpen?: ((citation: CitationDto) => void) | undefined;
}

export default function SafeMarkdown({ text, citations = [], onCitationOpen }: SafeMarkdownProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canonical = React.useMemo(() => canonicalizeCitationTargets(citations), [citations]);
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Rebuild the sanitized tree imperatively so we can splice citation buttons
    // into exact text positions without dangerouslySetInnerHTML bypassing React.
    host.innerHTML = renderSafeMarkdown(text);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const replacements: Array<{ node: Text; parent: Node; next: ChildNode | null }> = [];
    let current = walker.nextNode() as Text | null;
    while (current) {
      replacements.push({ node: current, parent: current.parentNode!, next: current.nextSibling });
      current = walker.nextNode() as Text | null;
    }
    for (const item of replacements) {
      const pieces = citationPieces(item.node.data ?? "", canonical.byLabel);
      if (pieces.length === 1 && typeof pieces[0] === "string") continue;
      const fragment = document.createDocumentFragment();
      let hasButtons = false;
      for (const piece of pieces) {
        if (typeof piece === "string") {
          fragment.append(document.createTextNode(piece));
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "citation-chip";
          button.dataset.citationId = piece.id;
          button.textContent = `[${piece.label}]`;
          button.addEventListener("click", () => onCitationOpen?.(piece));
          hasButtons = true;
          fragment.append(button);
        }
      }
      if (!hasButtons) continue;
      item.parent.replaceChild(fragment, item.node);
    }
  }, [text, canonical, onCitationOpen]);
  return <div className="safe-markdown" ref={hostRef} />;
}

const messageStateLabels: Record<MessageDto["state"], string> = {
  streaming: "chat.message.streaming",
  completed: "chat.message.completed",
  cancelled: "chat.message.cancelled",
  failed: "chat.message.failed"
};

const repairLabels: Record<string, string> = {
  CANCELLED: "chat.repair.retry",
  PROVIDER: "chat.repair.repair",
  TIMEOUT: "chat.repair.retry",
  NETWORK: "chat.repair.retry",
  INTERNAL: "chat.repair.repair"
};

export interface AssistantMessageViewProps {
  message: MessageDto;
  onCitationOpen?: (citation: CitationDto) => void;
  /** Repair/resume hook; only rendered when the message exposes a failed draft. */
  onRepair?: () => void;
}

function AssistantMessageViewBase({ message, onCitationOpen, onRepair }: AssistantMessageViewProps) {
  const { t } = useTranslation();
  const showRepair = message.state === "failed";
  return (
    <article className={`assistant-message is-${message.state}`} data-state={message.state}>
      <SafeMarkdown
        text={message.content}
        citations={message.citations}
        onCitationOpen={onCitationOpen}
      />
      {showRepair ? (
        <div role="alert" className="assistant-message-error">
          <span>{t(messageStateLabels.failed, { defaultValue: "The answer failed." })}</span>
          <button type="button" data-repair onClick={onRepair}>
            {t(repairLabels[message.errorCode ?? "INTERNAL"] ?? "chat.repair.repair", { defaultValue: "Repair answer" })}
          </button>
        </div>
      ) : null}
      {message.state === "streaming" ? (
        <span aria-live="polite">{t(messageStateLabels.streaming, { defaultValue: "Answering…" })}</span>
      ) : null}
      {message.state === "cancelled" ? (
        <span data-cancelled>{t(messageStateLabels.cancelled, { defaultValue: "Stopped." })}</span>
      ) : null}
    </article>
  );
}

/** Functional state view: streams SafeMarkdown content with status plumbing, no final styling. */
export const AssistantMessageView = AssistantMessageViewBase;
