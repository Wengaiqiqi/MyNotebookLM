import { isIP } from "node:net";

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

export class UrlPolicyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "UrlPolicyError";
  }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4Bytes(ip: string): number[] {
  return ip.split(".").map((part) => Number(part));
}

function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

/** Loopback, private, link-local, CGNAT, multicast, unspecified, benchmark, docs, reserved. */
function isForbiddenIpv4(ip: string): boolean {
 const octets = ipv4Bytes(ip);
 if (octets.length !== 4) return true; // defensively reject any non-canonical dotted form
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  const c = octets[2] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // private
  if (a === 100 && inRange(b, 64, 127)) return true; // CGNAT 100.64/10
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. metadata 169.254.169.254)
  if (a === 172 && inRange(b, 16, 31)) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF assignments
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 192 && b === 2) return true; // 192.0.2.0/24 documentation
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 documentation
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 documentation
  if (inRange(a, 224, 239)) return true; // multicast
  if (inRange(a, 240, 255)) return true; // reserved + broadcast
  return false;
}

function isForbiddenIpv6(ip: string): boolean {
  const compact = ip.toLowerCase();
  if (compact === "::") return true; // unspecified
  if (compact === "::1") return true; // loopback
  if (compact.startsWith("ff")) return true; // multicast ff00::/8
  if (compact.startsWith("fc") || compact.startsWith("fd")) return true; // ULA fc00::/7
  if (compact.startsWith("fe8") || compact.startsWith("fe9") || compact.startsWith("fea") || compact.startsWith("feb")) return true; // link-local fe80::/10
  if (compact.startsWith("2001:db8")) return true; // documentation
  return false;
}

function ipv6ToBytes(ip: string): number[] {
  const noZone = ip.split("%")[0] ?? "";
  const hasDoubleColon = noZone.includes("::");
  const headSource = hasDoubleColon ? noZone.split("::")[0] ?? "" : noZone;
  const tailSource = hasDoubleColon ? noZone.split("::")[1] ?? "" : "";
  const upper = headSource === "" ? [] : headSource.split(":");
  const lower = tailSource === "" ? [] : tailSource.split(":");
  const upperGroups = upper.map((g) => parseInt(g || "0", 16) || 0);
  const lowerGroups = lower.map((g) => parseInt(g || "0", 16) || 0);
  const fill = Math.max(0, 8 - upperGroups.length - lowerGroups.length);
  const all = [...upperGroups, ...Array(fill).fill(0), ...lowerGroups];
  const bytes: number[] = [];
  for (const group of all) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/** Extract the embedded IPv4 from an IPv4-mapped or IPv4-compatible IPv6 address. */
function embeddedIpv4(ip: string): string | undefined {
  const bytes = ipv6ToBytes(ip);
  if (bytes.length !== 16) return undefined;
  const isMapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (!isMapped && !isCompatible) return undefined;
  const u32 = [bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0];
  return u32.join(".");
}

export function isForbiddenIp(rawIp: string): boolean {
  const ip = stripBrackets(rawIp).split("%")[0] ?? "";
  const family = isIP(ip);
  if (family === 4) return isForbiddenIpv4(ip);
  if (family === 6) {
    const mapped = embeddedIpv4(ip);
    if (mapped) return isForbiddenIpv4(mapped);
    return isForbiddenIpv6(ip);
  }
  return false; // not an IP literal; host resolution rechecks each resolved address.
}

function explicitPortReason(raw: string): string | undefined {
  const match = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (!match) return undefined;
  let authority = match[0].slice(match[0].indexOf("//") + 2);
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  let portPart = "";
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return undefined;
    const after = authority.slice(close + 1);
    if (after.startsWith(":")) portPart = after.slice(1);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon !== -1) portPart = authority.slice(colon + 1);
  }
  if (portPart === "") return undefined;
  if (!/^[0-9]+$/.test(portPart)) return "port";
  const portNum = Number(portPart);
  if (portNum < 1 || portNum > 65535) return "port";
  return undefined;
}

export function parseSafeUrl(raw: string): URL {
  const badPort = explicitPortReason(raw);
  if (badPort) throw new UrlPolicyError("port must be an integer between 1 and 65535");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError("url is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlPolicyError("scheme must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlPolicyError("userinfo credentials are forbidden");
  }
  if (url.port === "0" || (url.port !== "" && !/^[1-9][0-9]{0,4}$/.test(url.port))) {
    throw new UrlPolicyError("port must be an integer between 1 and 65535");
  }
  const hostname = stripBrackets(url.hostname);
  if (isIP(hostname) > 0 && isForbiddenIp(hostname)) {
    throw new UrlPolicyError("host resolves to a forbidden address");
  }
  return url;
}
