import { describe, expect, it, vi } from "vitest";
import { createProxyAwareFetch, parseBypassList, shouldBypassProxy, type ProxiedSession } from "./model-fetch";

type Settings = { proxyMode: "system" | "direct" | "manual"; proxyUrl: string; proxyBypass: string };

function setup(initial: Settings) {
  let settings = initial;
  const proxied = {
    setProxy: vi.fn(async (_config: Parameters<ProxiedSession["setProxy"]>[0]) => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    fetch: vi.fn(async () => new Response("proxied"))
  } satisfies ProxiedSession;
  const direct = vi.fn(async () => new Response("direct"));
  const fetch = createProxyAwareFetch({ getSettings: () => settings, proxied, direct });
  const route = async (url: string | URL) => (await fetch(url)).text();
  return { proxied, direct, route, set: (next: Partial<Settings>) => { settings = { ...settings, ...next }; } };
}

describe("shouldBypassProxy", () => {
  const bypass = (url: string, list = "") => shouldBypassProxy(new URL(url), parseBypassList(list));

  it("always connects directly to this machine and the local network", () => {
    for (const url of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434", "http://192.168.1.20:11434", "http://10.0.0.5", "http://172.20.1.1", "http://ollama:11434"]) {
      expect(bypass(url), url).toBe(true);
    }
    for (const url of ["https://api.openai.com", "http://172.32.0.1", "https://8.8.8.8"]) {
      expect(bypass(url), url).toBe(false);
    }
  });

  it("matches exact hosts, wildcard suffixes and IP prefixes from the bypass list", () => {
    const list = "api.deepseek.com, *.aliyuncs.com;\nhttps://ollama.lan:11434/\n100.64.*";
    expect(bypass("https://api.deepseek.com/v1", list)).toBe(true);
    expect(bypass("https://deepseek.com/v1", list)).toBe(false);
    expect(bypass("https://dashscope.aliyuncs.com/compatible-mode/v1", list)).toBe(true);
    expect(bypass("https://aliyuncs.com", list)).toBe(true);
    expect(bypass("https://notaliyuncs.com", list)).toBe(false);
    expect(bypass("http://ollama.lan:11434", list)).toBe(true);
    expect(bypass("http://100.64.3.4", list)).toBe(true);
    expect(bypass("https://API.DeepSeek.com", list)).toBe(true);
  });
});

describe("createProxyAwareFetch", () => {
  it("follows the system proxy by default and keeps bypassed hosts direct", async () => {
    const { proxied, route } = setup({ proxyMode: "system", proxyUrl: "", proxyBypass: "api.deepseek.com" });
    expect(await route("https://api.openai.com/v1/models")).toBe("proxied");
    expect(await route(new URL("https://huggingface.co/model"))).toBe("proxied");
    expect(await route("https://api.deepseek.com/models")).toBe("direct");
    expect(await route("http://127.0.0.1:11434/api/tags")).toBe("direct");
    expect(proxied.setProxy).toHaveBeenCalledTimes(1);
    expect(proxied.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(proxied.fetch).toHaveBeenCalledWith("https://huggingface.co/model", undefined);
  });

  it("sends everything direct in direct mode", async () => {
    const { proxied, route } = setup({ proxyMode: "direct", proxyUrl: "", proxyBypass: "" });
    expect(await route("https://api.openai.com/v1/models")).toBe("direct");
    expect(proxied.setProxy).not.toHaveBeenCalled();
  });

  it("applies a manual proxy and re-applies it only when the settings change", async () => {
    const { proxied, route, set } = setup({ proxyMode: "manual", proxyUrl: "socks5://127.0.0.1:7891", proxyBypass: "" });
    await route("https://api.anthropic.com/v1/messages");
    await route("https://api.anthropic.com/v1/messages");
    expect(proxied.setProxy).toHaveBeenCalledTimes(1);
    expect(proxied.setProxy).toHaveBeenLastCalledWith({ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:7891" });
    set({ proxyUrl: "http://127.0.0.1:7890" });
    await route("https://api.anthropic.com/v1/messages");
    set({ proxyMode: "system" });
    await route("https://api.anthropic.com/v1/messages");
    expect(proxied.setProxy.mock.calls.map(([config]) => config)).toEqual([
      { mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:7891" },
      { mode: "fixed_servers", proxyRules: "http://127.0.0.1:7890" },
      { mode: "system" }
    ]);
    expect(proxied.closeAllConnections).toHaveBeenCalledTimes(3);
  });

  it("configures the proxy once for concurrent first requests and retries after a failure", async () => {
    const { proxied, route } = setup({ proxyMode: "system", proxyUrl: "", proxyBypass: "" });
    proxied.setProxy.mockRejectedValueOnce(new Error("boom"));
    await expect(route("https://api.openai.com")).rejects.toThrow("boom");
    await Promise.all([route("https://api.openai.com"), route("https://api.openai.com")]);
    expect(proxied.setProxy).toHaveBeenCalledTimes(2);
  });
});
