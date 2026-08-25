import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { SourceLocator } from "../../shared/sources";
import {
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  isForbiddenIp,
  parseSafeUrl,
  UrlPolicyError
} from "./url-policy";

export type DnsResolver = (host: string) => Promise<string[]>;

export type SafeResponse = {
  status: number;
  headers: Record<string, string>;
  url: string;
  body?: () => Uint8Array;
};

export type SafeRequestInit = { signal: AbortSignal; addresses: string[] };

export type SafeHttpClient = {
  request: (url: string, init: SafeRequestInit) => Promise<SafeResponse>;
};

export type UrlSourceOptions = {
  resolver: DnsResolver;
  client: SafeHttpClient;
  timeoutMs?: number;
};

export class UrlFetchError extends Error {
  constructor(readonly reason: string, readonly code: "UNSAFE_INPUT" | "NETWORK" | "TIMEOUT") {
    super(reason);
    this.name = "UrlFetchError";
  }
}

export class UnsupportedContentTypeError extends Error {
  constructor(readonly contentType: string) {
    super("unsupported content type: " + (contentType || "missing"));
    this.name = "UnsupportedContentTypeError";
  }
}

export type FetchedSection = { locator: Extract<SourceLocator, { kind: "section" }>; text: string };

export type FetchedArticle = {
  finalUrl: string;
  title: string;
  byline?: string;
  text: string;
  sections: FetchedSection[];
  contentHash: string;
};

function hostnameForResolve(url: URL): string {
  return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function createUrlSource(options: UrlSourceOptions) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  
  async function resolveAllowed(url: URL): Promise<string[]> {
    const host = hostnameForResolve(url);
    const addresses = isIP(host) > 0 ? [host] : await options.resolver(host);
    if (addresses.length === 0) throw new UrlFetchError("host did not resolve", "NETWORK");
    for (const address of addresses) {
      if (isIP(address) === 0 || isForbiddenIp(address)) {
        throw new UrlFetchError("host resolves to a forbidden address", "UNSAFE_INPUT");
      }
    }
    return addresses;
  }
  
  async function fetch(rawUrl: string): Promise<FetchedArticle> {
    let current = rawUrl;
    let redirectCount = 0;
    while (true) {
      let url: URL;
      try {
        url = parseSafeUrl(current);
      } catch (reason) {
        if (reason instanceof UrlPolicyError) throw new UrlFetchError(reason.reason, "UNSAFE_INPUT");
        throw reason;
      }
      const addresses = await resolveAllowed(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: SafeResponse;
      try {
        response = await options.client.request(url.href, { signal: controller.signal, addresses });
      } catch (reason) {
        if (controller.signal.aborted) {
          throw new UrlFetchError("request timed out", "TIMEOUT");
        }
        throw new UrlFetchError(reason instanceof Error ? reason.message : "request failed", "NETWORK");
      } finally {
        clearTimeout(timer);
      }
      if (redirectStatus(response.status) && response.headers.location) {
        redirectCount += 1;
        // ponytail: stop on the 5th redirect rather than following a 6th hop; relax to `>` if the final 200 route is wanted.
        if (redirectCount >= MAX_REDIRECTS) throw new UrlFetchError("too many redirects", "NETWORK");
        current = new URL(response.headers.location, url).href;
        continue;
      }
      const contentType = response.headers["content-type"] ?? "";
      if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml+xml")) {
        throw new UnsupportedContentTypeError(contentType);
      }
      const bytes = response.body ? response.body() : new Uint8Array(0);
      if (bytes.byteLength > MAX_BODY_BYTES) {
        throw new UrlFetchError("body exceeds 20 MiB decompressed limit", "UNSAFE_INPUT");
      }
      return extractArticle(new TextDecoder().decode(bytes), response.url || url.href);
    }
  }
  return { fetch };
}

function extractArticle(html: string, finalUrl: string): FetchedArticle {
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const parsed = reader.parse();
  if (!parsed || !parsed.content) {
    throw new UrlFetchError("article could not be extracted", "NETWORK");
  }
  const { document: contentDocument } = parseHTML(parsed.content);
  stripActiveAndRemote(contentDocument);
  const headingPath: string[] = [];
  const sections: FetchedSection[] = [];
  const blockElements = contentDocument.querySelectorAll("h1, h2, h3, h4, h5, h6, p");
  for (const element of Array.from(blockElements)) {
    const tag = element.localName.toLowerCase();
    const text = normalizeWhitespace(element.textContent ?? "");
    if (!text) continue;
    if (tag !== "p") {
      const depth = Number(tag.slice(1));
      while (headingPath.length >= depth) headingPath.pop();
      headingPath.push(text);
      sections.push({ text, locator: sectionLocator(headingPath, finalUrl) });
    } else {
      sections.push({ text, locator: sectionLocator(headingPath, finalUrl) });
    }
  }
  const text = normalizeWhitespace(parsed.textContent ?? "");
  const byline = parsed.byline || undefined;
  return {
    finalUrl,
    title: parsed.title || "",
    ...(byline ? { byline } : {}),
    text,
    sections,
    contentHash: createHash("sha256").update(text).digest("hex")
  };
}

function stripActiveAndRemote(document: Document): void {
  const tags = [
    "script", "style", "form", "iframe", "frame", "embed", "object",
    "img", "picture", "video", "audio", "source", "track", "link", "svg"
  ];
  for (const tag of tags) {
    // linkedom returns a live HTMLCollection whose length stalls after removal; snapshot first.
    for (const element of Array.from(document.getElementsByTagName(tag))) {
      if (element.parentNode) element.parentNode.removeChild(element);
    }
  }
  // Neutralize any residual event handlers and remote href/src on remaining nodes.
  const all = document.getElementsByTagName("*");
  for (const element of Array.from(all)) {
    for (const name of Array.from(element.attributes)) {
      const attr = name.name.toLowerCase();
      if (attr === "href" || attr === "src" || attr === "srcset" || attr === "action" ||
        attr.startsWith("on")) {
        element.removeAttribute(name.name);
      }
    }
  }
}

function sectionLocator(headingPath: string[], url: string): Extract<SourceLocator, { kind: "section" }> {
  return {
    kind: "section",
    sectionPath: headingPath.length ? headingPath.join(" > ") : "root",
    url
  };
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
