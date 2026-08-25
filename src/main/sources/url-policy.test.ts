import { describe, expect, it } from "vitest";
import {
  UrlPolicyError,
  isForbiddenIp,
  parseSafeUrl
} from "./url-policy";

function safeUrl(raw: string): string {
  return parseSafeUrl(raw).href;
}

function expectReject(raw: string, reasonContaining?: string): void {
  let reason: string | undefined;
  try {
    parseSafeUrl(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(UrlPolicyError);
    reason = (error as UrlPolicyError).reason;
  }
  expect(reason).toBeDefined();
  if (reasonContaining) expect(reason).toContain(reasonContaining);
}

describe("parseSafeUrl", () => {
  it("allows http and https public URLs", () => {
    expect(safeUrl("https://example.com/article")).toContain("example.com/article");
    expect(safeUrl("http://93.184.216.34/path")).toContain("93.184.216.34/path");
  });

  it("rejects unsupported schemes", () => {
    expectReject("ftp://example.com/file", "scheme");
    expectReject("file:///etc/passwd", "scheme");
    expectReject("gopher://example.com", "scheme");
    expectReject("javascript:alert(1)", "scheme");
  });

  it("rejects userinfo credentials", () => {
    expectReject("http://user:pass@example.com/", "userinfo");
    expectReject("https://admin@example.com/", "userinfo");
  });

  it("rejects invalid or zero ports", () => {
    expectReject("http://example.com:99999/", "port");
    expectReject("https://example.com:0/", "port");
    expectReject("http://example.com:abc/", "port");
    expectReject("http://example.com:65536/", "port");
  });

  it("rejects loopback and private literal IPv4 hosts", () => {
    expectReject("http://127.0.0.1/", "forbidden");
    expectReject("http://10.0.0.1/", "forbidden");
    expectReject("http://172.16.0.1/", "forbidden");
    expectReject("http://192.168.1.1/", "forbidden");
  });

  it("rejects link-local, metadata, multicast and unspecified IPv4", () => {
    expectReject("http://169.254.169.254/latest/meta-data/", "forbidden");
    expectReject("http://100.100.100.200/", "forbidden");
    expectReject("http://224.0.0.1/", "forbidden");
    expectReject("http://0.0.0.0/", "forbidden");
    expectReject("http://2130706433/", "forbidden");
  });

  it("normalizes decimal, hex and shorthand IPv4 disguises to forbidden loopback", () => {
    expectReject("http://2130706433/", "forbidden");
    expectReject("http://0x7f000001/", "forbidden");
    expectReject("http://0177.0.0.1/", "forbidden");
    expectReject("http://127.1/", "forbidden");
    expectReject("http://0x7f.0.0.1/", "forbidden");
  });

  it("rejects IPv4-mapped IPv6 destinations", () => {
    expectReject("http://[::1]/", "forbidden");
    expectReject("http://[::ffff:127.0.0.1]/", "forbidden");
    expectReject("http://[::ffff:7f00:1]/", "forbidden");
    expectReject("http://[::ffff:192.168.1.1]/", "forbidden");
    expectReject("http://[::ffff:c0a8:101]/", "forbidden");
    expectReject("http://[0:0:0:0:0:ffff:7f00:1]/", "forbidden");
  });

  it("rejects link-local, ULA, multicast and unspecified IPv6", () => {
    expectReject("http://[fe80::1]/", "forbidden");
    expectReject("http://[fc00::1]/", "forbidden");
    expectReject("http://[fd12:3456:789a::1]/", "forbidden");
    expectReject("http://[ff02::1]/", "forbidden");
    expectReject("http://[::]/", "forbidden");
  });
});

describe("isForbiddenIp", () => {
  it("classifies every private/loopback/link-local/multicast/unspecified range", () => {
    const forbidden = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.100.100.200",
      "224.0.0.1",
      "240.0.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:192.168.1.1",
      "fe80::1",
      "fc00::1",
      "ff02::1"
    ];
    for (const ip of forbidden) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
  });

  it("allows public and documentation-grade non-routable-but-allowed targets", () => {
    const allowed = ["93.184.216.34", "8.8.8.8", "2001:4860:4860::8888"];
    for (const ip of allowed) {
      expect(isForbiddenIp(ip), ip).toBe(false);
    }
  });
});
