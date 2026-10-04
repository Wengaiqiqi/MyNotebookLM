import type { FetchLike } from "../models/http-client";
import type { AppSettingsDto } from "../../shared/settings";

type ProxySettings = Pick<AppSettingsDto, "proxyMode" | "proxyUrl" | "proxyBypass">;

/** The subset of an Electron session the proxied route needs. */
export type ProxiedSession = {
  setProxy(config: { mode: "system" } | { mode: "fixed_servers"; proxyRules: string }): Promise<void>;
  closeAllConnections(): Promise<void>;
  fetch: SessionFetch;
};
/** Electron's session.fetch: like fetch, but it does not take URL objects. */
export type SessionFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

let installed: FetchLike | undefined;

/**
 * Fetch for model providers and model downloads. Main installs the
 * proxy-aware implementation at startup; until then (and in tests) it is the
 * global fetch, looked up per call so test stubs still apply.
 */
export const modelFetch: FetchLike = (input, init) => (installed ?? globalThis.fetch)(input, init);

export function installModelFetch(impl: FetchLike | undefined): void {
  installed = impl;
}

export function parseBypassList(text: string): string[] {
  return text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function isPrivateAddress(host: string): boolean {
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function matchesPattern(host: string, pattern: string): boolean {
  const bare = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (bare.startsWith("*.") || bare.startsWith(".")) {
    const suffix = bare.replace(/^\*?\./, "");
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  if (bare.endsWith(".*")) return host.startsWith(bare.slice(0, -1));
  return host === bare;
}

/**
 * Loopback, private-network addresses and single-label LAN names never go
 * through a proxy: a remote proxy cannot reach them. Anything on the user's
 * bypass list connects directly too (domestic providers, LAN model servers).
 */
export function shouldBypassProxy(url: URL, bypass: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".") && !host.includes(":")) return true;
  if (isPrivateAddress(host)) return true;
  return bypass.some((pattern) => matchesPattern(host, pattern));
}

function requestUrl(input: string | Request): URL {
  return new URL(typeof input === "string" ? input : input.url);
}

/**
 * Routes each request either through `proxied` (configured from the current
 * settings: the OS proxy, or a manual address) or straight through `direct`.
 */
export function createProxyAwareFetch(options: {
  getSettings: () => ProxySettings;
  proxied: ProxiedSession;
  direct: SessionFetch;
}): FetchLike {
  let applied: string | undefined;
  let applying = Promise.resolve();
  const applyProxy = (settings: ProxySettings) => {
    const key = settings.proxyMode === "manual" ? `manual ${settings.proxyUrl}` : "system";
    applying = applying.catch(() => undefined).then(async () => {
      if (applied === key) return;
      applied = undefined;
      await options.proxied.setProxy(settings.proxyMode === "manual"
        ? { mode: "fixed_servers", proxyRules: settings.proxyUrl }
        : { mode: "system" });
      // Pooled sockets keep the old route; drop them so the change applies now.
      await options.proxied.closeAllConnections();
      applied = key;
    });
    return applying;
  };
  return async (rawInput, init) => {
    const input = rawInput instanceof URL ? rawInput.href : rawInput;
    const settings = options.getSettings();
    if (settings.proxyMode === "direct" || shouldBypassProxy(requestUrl(input), parseBypassList(settings.proxyBypass))) {
      return options.direct(input, init);
    }
    await applyProxy(settings);
    return options.proxied.fetch(input, init);
  };
}
