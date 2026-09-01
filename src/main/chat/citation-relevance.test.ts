import { describe, expect, it } from "vitest";
import { citationClaim, relevantSourceExcerpt, relevantSourceRange } from "./citation-relevance";

describe("citation relevance", () => {
  it("selects the source sentence that overlaps the cited answer claim", () => {
    const source = "Open Notebook supports many providers. Start services with Docker Compose. Data remains local.";
    const claim = citationClaim("You can start services with Docker Compose [S1].", 43);
    expect(relevantSourceExcerpt(source, claim)).toBe("Start services with Docker Compose.");
    expect(relevantSourceRange(source, claim)).toEqual({ start: 39, end: 74 });
  });
});
