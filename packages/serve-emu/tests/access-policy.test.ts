import { describe, expect, test } from "bun:test";
import {
  assertValidToken,
  displayHost,
  InvalidTokenError,
  isLoopbackHost,
  resolveAccessPolicy,
  startupUrl,
  TOKEN_CHARACTERS,
} from "../src/access-policy.ts";

describe("isLoopbackHost", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["127.1", true],
    ["localhost", true],
    ["LOCALHOST", true],
    ["::1", true],
    ["[::1]", true],
    ["0:0:0:0:0:0:0:1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    [" 127.0.0.1 ", true],
    ["0.0.0.0", false],
    ["::", false],
    ["[::]", false],
    ["127.example.com", false],
    ["192.168.1.10", false],
    ["::ffff:10.0.0.1", false],
    ["fe80::1", false],
    ["localhost.", false],
    ["app.localhost", false],
    ["::1%lo", false],
    ["127.0.0.1:80", false],
    ["", false],
  ])("%p → %p", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});

describe("tokens", () => {
  test("accepts every allowed character class", () => {
    expect(() => assertValidToken("AZaz09._~-")).not.toThrow();
  });

  test.each(["a;b", "a,b", 'a"b', "a\\b", "a b", "a+b", "a&b", "a#b", "a%20b", "a=b", "a/b", "ä"])(
    "rejects %p",
    (token) => {
      expect(() => assertValidToken(token)).toThrow(InvalidTokenError);
      expect(() => assertValidToken(token)).toThrow(`--token may only contain ${TOKEN_CHARACTERS}.`);
    },
  );
});

describe("resolveAccessPolicy", () => {
  const generateToken = () => "generated";

  test("loopback keeps auth off unless a token is given", () => {
    expect(resolveAccessPolicy({ host: "127.0.0.1", generateToken })).toEqual({
      token: undefined,
      loopback: true,
      warnings: [],
    });
    expect(resolveAccessPolicy({ host: "::1", token: "given", generateToken }).token).toBe("given");
  });

  test("non-loopback binds use the given token or generate one", () => {
    expect(resolveAccessPolicy({ host: "0.0.0.0", token: "given", generateToken }).token).toBe("given");
    expect(resolveAccessPolicy({ host: "0.0.0.0", token: "", generateToken })).toEqual({
      token: "generated",
      loopback: false,
      warnings: [],
    });
  });

  test("a DNS name that only looks like 127.x requires a token", () => {
    expect(resolveAccessPolicy({ host: "127.example.com", generateToken })).toMatchObject({
      token: "generated",
      loopback: false,
    });
  });

  test("--unsafe-no-auth turns auth off on a non-loopback bind, with a warning", () => {
    const policy = resolveAccessPolicy({ host: "0.0.0.0", unsafeNoAuth: true, generateToken });
    expect(policy.token).toBeUndefined();
    expect(policy.warnings).toEqual([
      "WARNING: bound to non-loopback address 0.0.0.0 with --unsafe-no-auth. " +
        "The device is reachable and controllable without authentication.",
    ]);
    // On loopback the flag changes nothing.
    expect(resolveAccessPolicy({ host: "127.0.0.1", unsafeNoAuth: true, generateToken }).warnings).toEqual([]);
  });

  test("rejects a token with unsupported characters, on any bind", () => {
    for (const host of ["127.0.0.1", "0.0.0.0"]) {
      expect(() => resolveAccessPolicy({ host, token: "abc;def", generateToken })).toThrow(InvalidTokenError);
    }
  });
});

describe("startup URL", () => {
  test("shows wildcard binds as localhost and brackets IPv6 literals", () => {
    expect(displayHost("0.0.0.0")).toBe("localhost");
    expect(displayHost("::")).toBe("localhost");
    expect(displayHost("::1")).toBe("[::1]");
    expect(displayHost("[::1]")).toBe("[::1]");
    expect(displayHost("192.168.1.10")).toBe("192.168.1.10");
  });

  test("appends an encoded token only when auth is on", () => {
    expect(startupUrl("http://localhost:3300", undefined)).toBe("http://localhost:3300/");
    expect(startupUrl("http://localhost:3300", "AZaz09._~-")).toBe("http://localhost:3300/?token=AZaz09._~-");
    expect(new URL(startupUrl("http://h", "x~y")).searchParams.get("token")).toBe("x~y");
  });
});
