import { describe, expect, test } from "bun:test";
import {
  createHostAllowlist,
  fetchMetadataAllowed,
  normalizeHostname,
} from "../src/server/request-policy.ts";

describe("normalizeHostname", () => {
  test("strips ports, brackets, case, and a trailing dot", () => {
    expect(normalizeHostname("LocalHost:3300")).toBe("localhost");
    expect(normalizeHostname("[::1]:3300")).toBe("::1");
    expect(normalizeHostname("::1")).toBe("::1");
    expect(normalizeHostname("devbox.lan.")).toBe("devbox.lan");
    expect(normalizeHostname(" 127.0.0.1 ")).toBe("127.0.0.1");
  });

  test("canonicalizes IPv4 shorthand the way browsers do", () => {
    expect(normalizeHostname("127.1:3300")).toBe("127.0.0.1");
    expect(normalizeHostname("0x7f000001")).toBe("127.0.0.1");
  });

  test("rejects anything that is not a bare authority", () => {
    for (const value of [
      "",
      "   ",
      "evil.example/path",
      "user@localhost",
      "localhost?x=1",
      "localhost#x",
      "local host",
      "localhost:notaport",
      "back\\slash",
    ]) {
      expect(normalizeHostname(value)).toBeNull();
    }
  });
});

describe("createHostAllowlist", () => {
  const allowed = createHostAllowlist(["127.0.0.1", "DevBox.lan", undefined]);

  test("accepts names that cannot be DNS-rebound", () => {
    for (const host of [
      "127.0.0.1:3300",
      "127.0.0.2",
      "[::1]:3300",
      "192.168.1.20:3300",
      "localhost:5173",
      "app.localhost:3300",
      "localhost.",
    ]) {
      expect(allowed(host)).toBe(true);
    }
  });

  test("accepts configured names regardless of case and port", () => {
    expect(allowed("devbox.lan:3300")).toBe(true);
    expect(allowed("DEVBOX.LAN")).toBe(true);
  });

  test("rejects other DNS names, including look-alikes", () => {
    for (const host of [
      "evil.example:3300",
      "127.0.0.1.nip.io:3300",
      "localhost.evil.example",
      "devbox.lan.evil.example",
      "",
      "evil.example/",
    ]) {
      expect(allowed(host)).toBe(false);
    }
  });

  test("lets requests without a Host header through", () => {
    expect(allowed(null)).toBe(true);
  });
});

describe("fetchMetadataAllowed", () => {
  const request = (
    headers: Record<string, string>,
    method = "GET",
  ): Request =>
    new Request("http://127.0.0.1:3300/api/screenshot", { method, headers });

  test("allows clients that send no Fetch Metadata", () => {
    expect(fetchMetadataAllowed(request({}))).toBe(true);
    expect(fetchMetadataAllowed(request({}, "POST"))).toBe(true);
  });

  test("allows same-origin, same-site, and user-initiated requests", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      expect(
        fetchMetadataAllowed(
          request({ "sec-fetch-site": site, "sec-fetch-mode": "cors" }, "POST"),
        ),
      ).toBe(true);
    }
  });

  test("allows cross-site navigations into documents and frames", () => {
    for (const dest of ["document", "iframe"]) {
      expect(
        fetchMetadataAllowed(
          request({
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": dest,
          }),
        ),
      ).toBe(true);
    }
  });

  test("rejects cross-site subresources, scripts, sockets, and plugin embeds", () => {
    const rejected: Array<[Record<string, string>, string]> = [
      [{ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }, "GET"],
      [{ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }, "GET"],
      [{ "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" }, "GET"],
      [{ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, "POST"],
      [{ "sec-fetch-mode": "navigate", "sec-fetch-dest": "object" }, "GET"],
      [{ "sec-fetch-mode": "navigate", "sec-fetch-dest": "embed" }, "GET"],
    ];
    for (const [headers, method] of rejected) {
      expect(
        fetchMetadataAllowed(
          request({ "sec-fetch-site": "cross-site", ...headers }, method),
        ),
      ).toBe(false);
    }
  });
});
