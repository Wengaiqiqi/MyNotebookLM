import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
 MAX_REDIRECTS,
 REQUEST_TIMEOUT_MS
} from "./url-policy";
import {
  UnsupportedContentTypeError,
  UrlFetchError,
  createUrlSource,
  type SafeHttpClient,
  type SafeResponse
} from "./url-source";

type FakeRoute = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bytes?: number;
  delayMs?: number;
};


describe("url-source policy wiring", () => {
  it("exposes the documented default limits", () => {
    expect(MAX_REDIRECTS).toBe(5);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("rejects a forbidden resolved address before connecting", async () => {
    const source = createUrlSource({
      resolver: async (host: string) => {
        expect(host).toBe("safe.example");
        return ["127.0.0.1"];
      },
      client: fakeClient({})
    });
    const error = await source.fetch("https://safe.example/article").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlFetchError);
    expect((error as UrlFetchError).reason).toContain("forbidden");
    expect((error as UrlFetchError).code).toBe("UNSAFE_INPUT");
  });

  it("rejects a resolver that returns a non-IP host", async () => {
    let connected = false;
    const source = createUrlSource({
      resolver: async () => ["safe.example"],
      client: { request: async () => { connected = true; return { status: 200, headers: {}, url: "https://safe.example/" }; } }
    });
    const error = await source.fetch("https://safe.example/article").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlFetchError);
    expect((error as UrlFetchError).reason).toContain("forbidden");
    expect(connected).toBe(false);
  });
});

describe("url-source request lifecycle", () => {
  it("charset-decodes the body and parses article sections", async () => {
    const html = [
      "<!doctype html><html><head><title>核心研究报告</title></head><body>",
      "<article><h1>第一章 概览</h1><p>这是第一段正文，介绍背景。</p>",
      "<script>alert('x')</script>",
      "<h2>1.1 方法</h2><p>采用可控实验方法。</p>",
      "<iframe src='https://evil.example'></iframe>",
      "<style>.hidden{display:none}</style>",
      "</article></body></html>"
    ].join("");
    const source = createUrlSource({
      resolver: async () => ["93.184.216.34"],
      client: fakeClient({
        "/article": { body: html, headers: { "content-type": "text/html; charset=utf-8" } }
      })
    });
    const article = await source.fetch("https://blog.example/article");
    expect(article.title).toBe("核心研究报告");
    expect(article.finalUrl).toContain("/article");
    expect(article.text).toContain("第一章 概览");
    expect(article.text).toContain("这是第一段正文");
    expect(article.text).not.toContain("alert");
    expect(article.text).not.toContain("evil.example");
   expect(article.sections.length).toBeGreaterThanOrEqual(2);
    const first = article.sections[0]!;
    expect(first.locator.kind).toBe("section");
    expect((first.locator as { url: string }).url).toContain("/article");
    expect((first.locator as { sectionPath: string }).sectionPath).toContain("第一章 概览");
    expect(article.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads the bundled HTML fixture and strips active and remote content", async () => {
    const html = readFileSync(resolve("src/test/fixtures/url/article.html"), "utf8");
    const source = createUrlSource({
      resolver: async () => ["93.184.216.34"],
      client: fakeClient({ "/fixture": { body: html, headers: { "content-type": "text/html; charset=utf-8" } } })
    });
    const article = await source.fetch("https://blog.example/fixture");
    expect(article.title).toBe("安全导入：分布式系统演进");
    expect(article.text).toContain("一致性模型");
    expect(article.text).not.toContain("恶意脚本");
    expect(article.text).not.toContain("tracker.example");
    expect(article.text).not.toContain("ads.example");
    expect(article.text).not.toContain("evil.example");
    const sectionPaths = article.sections.map((section) => section.locator.sectionPath);
    expect(sectionPaths).toContain("第一章 概览 > 1.1 一致性模型");
    expect(sectionPaths).toContain("第一章 概览");
    expect(article.finalUrl).toContain("/fixture");
  });

  it("rejects a non-HTML content type", async () => {
    const source = createUrlSource({
      resolver: async () => ["93.184.216.34"],
      client: fakeClient({
        "/file": { body: "binary", headers: { "content-type": "application/octet-stream" } }
      })
    });
    const error = await source.fetch("https://blog.example/file").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UnsupportedContentTypeError);
  });

  it("aborts when the decompressed body exceeds the cap", async () => {
    const source = createUrlSource({
      resolver: async () => ["93.184.216.34"],
      client: fakeClient({
        "/big": { bytes: 21 * 1024 * 1024, headers: { "content-type": "text/html" } }
      })
    });
    const error = await source.fetch("https://blog.example/big").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlFetchError);
    expect((error as UrlFetchError).reason).toContain("20 MiB");
  });

  it("enforces the connect timeout", async () => {
    const source = createUrlSource({
      resolver: async () => ["93.184.216.34"],
      client: fakeClient({
        "/slow": { delayMs: 40_000, headers: { "content-type": "text/html" } }
      }),
      timeoutMs: 5
    });
    const error = await source.fetch("https://blog.example/slow").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlFetchError);
    expect((error as UrlFetchError).reason).toContain("timed out");
  });

  it("re-validates every redirect hop and rejects a forbidden target", async () => {
    let hops = 0;
    const source = createUrlSource({
      resolver: async (host: string) => {
        void host;
        return ["93.184.216.34"];
      },
      client: fakeClient({
        "/start": { status: 302, headers: { location: "https://blog.example/loop" } },
        "/loop": { status: 302, headers: { location: "https://127.0.0.1/evil" } }
      })
    });
    const error = await source.fetch("https://blog.example/start").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlFetchError);
    expect((error as UrlFetchError).reason).toContain("forbidden");
  });

  it("stops after the redirect budget", async () => {
    let redirects = 0;
    const source = createUrlSource({
      resolver: async () => ["93.184.216.34"],
      client: {
        request: async (input) => {
          const url = new URL(String(input));
          redirects += 1;
          return redirects <= MAX_REDIRECTS
            ? { status: 302, headers: { location: url.href.replace("/hop", "/hop") }, url: url.href }
            : { status: 200, headers: { "content-type": "text/html" }, url: url.href, body: () => new TextEncoder().encode("<h1>done</h1>") };
        }
      }
    });
    const error = await source.fetch("https://blog.example/hop").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlFetchError);
    expect((error as UrlFetchError).reason).toContain("redirects");
    expect(redirects).toBe(5);
  });
});

function fakeClient(routes: Record<string, FakeRoute>): SafeHttpClient {
  return {
    request: (input, init) => {
      const url = new URL(String(input));
      const route = routes[url.pathname] ?? {};
      return new Promise<SafeResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          const headers: Record<string, string> = {
            "content-type": "text/html",
            ...(route.headers ?? {})
          };
          const bodyBytes = route.body !== undefined
            ? new TextEncoder().encode(route.body)
            : route.bytes !== undefined ? new Uint8Array(route.bytes) : undefined;
          if (bodyBytes) headers["content-length"] = String(bodyBytes.byteLength);
          resolve({
            status: route.status ?? 200,
            headers,
            url: url.href,
            ...(bodyBytes ? { body: () => bodyBytes } : {})
          });
        }, route.delayMs ?? 0);
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        }
      });
    }
  };
}
