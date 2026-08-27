// @vitest-environment jsdom

import * as React from "react";
import DOMPurify from "dompurify";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitationDto, MessageDto } from "../../../shared/chat";
import { citationSchema, messageStateSchema } from "../../../shared/chat";
import SafeMarkdown, { AssistantMessageView } from "./SafeMarkdown";

const roots: Root[] = [];

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
});

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()!;
    root.unmount();
    await Promise.resolve();
  }
});

const baseCitation: CitationDto = citationSchema.parse({
  id: "msg-1:S1:12",
  label: "S1",
  sourceId: "11111111-1111-4111-8111-111111111111",
  sourceChunkId: "chunk-1",
  sourceDisplayName: "Report.pdf",
  sourceKind: "pdf",
  locator: { kind: "page", page: 3 },
  start: 12
});

function assistantMessage(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    sequence: 2,
    role: "assistant",
    content: "",
    state: messageStateSchema.parse("completed"),
    replyToMessageId: null,
    supersedesMessageId: null,
    superseded: false,
    provider: "openai",
    profileId: "p1",
    model: "gpt-test",
    usage: null,
    errorCode: null,
    completionReason: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    citations: [],
    ...overrides
  };
}

describe("SafeMarkdown sanitization", () => {
  it.each([
    ["script", "<script>alert(1)</script>"],
    ["raw html heading", "<h1>Injected</h1><p>p</p>"],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ["style tag", "<style>body{color:red}</style>plain"],
    ['inline handler', '<img src="x" onerror="alert(1)">alt'],
    ['svg onload', '<svg><circle r="1" onload="alert(1)"/></svg>dot']
  ])("strips %s", async (_name, input) => {
    const container = await render(<SafeMarkdown text={input} citations={[]} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // Raw HTML is escaped to inert literal text; handlers never attach.
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it.each([
    ["javascript:", "[click](javascript:alert(1))"],
    ["data:", "[click](data:text/html;base64,PHNjcmlwdD4=)"]
  ])("neutralizes unsafe %s links", async (_name, input) => {
    const container = await render(<SafeMarkdown text={input} citations={[]} />);
    const anchor = container.querySelector("a");
    if (anchor) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href.startsWith("#") || href === "").toBe(true);
    }
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("data:text/html");
  });

  it("keeps lists, tables and code while stripping remote images", async () => {
    const md = [
      "Intro text",
      "",
      "- item one",
      "- item two",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "console.log('safe');",
      "```"
    ].join("\n");
    const container = await render(
      <SafeMarkdown text={md + "\n\n![remote](https://cdn.example/pixel.png)"} citations={[]} />
    );

    expect(container.querySelector("pre code")).not.toBeNull();
    expect(container.textContent).toContain("console.log('safe')");
    expect([...container.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["item one", "item two"]);
    expect(container.querySelectorAll("th").length).toBe(2);
    expect(container.querySelectorAll("td").length).toBe(2);
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps safe https links with hardened attributes", async () => {
    const container = await render(
      <SafeMarkdown text="[docs](https://example.com/docs)" citations={[]} />
    );
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/docs");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
  });

  it("renders citation tokens as buttons only when matching structured CitationDto rows", async () => {
    const opened: string[] = [];
    const container = await render(
      <SafeMarkdown
        text={"Grounded claim [S1] plus unknown [S7]."}
        citations={[baseCitation]}
        onCitationOpen={(c) => { opened.push(c.id); }}
      />
    );
    const buttons = [...container.querySelectorAll("button.citation-chip")];
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toBe("[S1]");
    (buttons[0] as HTMLElement | null)?.click();
    expect(opened).toEqual([baseCitation.id]);
    // Unknown labels stay visible as plain text, never invented sources.
    expect(container.textContent).toContain("[S7]");
    expect(container.querySelectorAll("button").length).toBe(1);
  });

  it("renders no button when citations list is empty", async () => {
    const container = await render(
      <SafeMarkdown text={"Mention [S2] without rows."} citations={[]} />
    );
    expect(container.querySelector(".citation-chip")).toBeNull();
    expect(container.textContent).toContain("[S2]");
  });
});

describe("AssistantMessageView", () => {
  it("keeps safe link href by passing the explicit attribute allowlist to sanitize", async () => {
    const container = await render(
      <SafeMarkdown text={"[docs](https://example.com/docs) and ![img](https://cdn.example/x.png)"} citations={[]} />
    );
    // ALLOWED_ATTR = ["href"] must actually reach DOMPurify: link href survives.
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.querySelector("a")?.getAttributeNames()).toEqual(["href", "target", "rel"]);
  });

  it("registers the link-hardening hook once instead of accumulating per render", async () => {
    const addHookSpy = vi.spyOn(DOMPurify, "addHook");
    for (let i = 0; i < 3; i += 1) {
      await render(<SafeMarkdown text="[x](https://example.com)" citations={[]} />);
    }
    expect(addHookSpy).not.toHaveBeenCalled();
  });

  it("shows failed state preserving partial content and exposes repair action", async () => {
    let repairs = 0;
    const container = await render(
      <AssistantMessageView
        message={assistantMessage({
          state: "failed",
          errorCode: "PROVIDER",
          content: "Partial reasoning preserved even when failing"
        })}
        onRepair={() => { repairs += 1; }}
      />
    );
    expect(container.textContent).toContain("Partial reasoning preserved even when failing");
    container.querySelector<HTMLButtonElement>("button[data-repair]")?.click();
    expect(repairs).toBe(1);
  });

  it("shows cancelled state preserving the partial answer without repair action", async () => {
    const container = await render(
      <AssistantMessageView
        message={assistantMessage({ state: "cancelled", content: "stopped midway" })}
      />
    );
    expect(container.textContent).toContain("stopped midway");
    expect(container.querySelector("[data-repair]")).toBeNull();
  });

  it("shows streaming state before completion", async () => {
    const container = await render(
      <AssistantMessageView
        message={assistantMessage({ state: "streaming", content: "so far" })}
      />
    );
    expect(container.textContent).toContain("so far");
    expect(container.querySelector("[data-repair]")).toBeNull();
  });
});
