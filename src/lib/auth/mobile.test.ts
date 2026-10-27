// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  appTokenClientCode,
  fetchMetadataProblem,
  hasHandoffHeaders,
  hasTokenInQuery,
  mobileErrorRedirect,
  mobileNotice,
  parseHandoff,
} from "./mobile";
import { appToken } from "./test-tokens";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = appToken({ LoginId: "TEST0001", unique_name: "TEST0001" });

const headersOf = (values: Record<string, string>) => new Headers(values);

describe("parseHandoff", () => {
  it("reads the platform, the token and the client code inside it", () => {
    expect(
      parseHandoff(
        headersOf({ "X-Bigul-Platform": "7", "X-Bigul-Token": TOKEN }),
        ["7"],
      ),
    ).toEqual({ platform: "7", token: TOKEN, clientCode: "TEST0001" });
  });

  it("falls back to unique_name and normalises the code", () => {
    const token = appToken({ unique_name: " test0001 " });
    expect(
      parseHandoff(
        headersOf({ "x-bigul-platform": "7", "x-bigul-token": token }),
        ["7"],
      )?.clientCode,
    ).toBe("TEST0001");
  });

  it.each([
    ["no token", { "x-bigul-platform": "7" }],
    ["no platform", { "x-bigul-token": TOKEN }],
    [
      "a platform not allowed",
      { "x-bigul-platform": "5", "x-bigul-token": TOKEN },
    ],
    [
      "a non-numeric platform",
      { "x-bigul-platform": "7a", "x-bigul-token": TOKEN },
    ],
    [
      "a pre-encoded token",
      { "x-bigul-platform": "7", "x-bigul-token": `${TOKEN}%3D` },
    ],
    [
      "a token with a space",
      { "x-bigul-platform": "7", "x-bigul-token": `${TOKEN} x` },
    ],
    [
      "a repeated token header",
      { "x-bigul-platform": "7", "x-bigul-token": `${TOKEN}, ${TOKEN}` },
    ],
    [
      "a token that is not a JWT",
      {
        "x-bigul-platform": "7",
        "x-bigul-token": "abcdefghijklmnopqrstuvwxyz",
      },
    ],
    [
      "an oversized token",
      {
        "x-bigul-platform": "7",
        "x-bigul-token": `${TOKEN}${"a".repeat(4096)}`,
      },
    ],
    [
      "a token naming no client",
      { "x-bigul-platform": "7", "x-bigul-token": appToken({ sub: "x" }) },
    ],
    [
      "a token naming a malformed client",
      {
        "x-bigul-platform": "7",
        "x-bigul-token": appToken({ LoginId: "Y0/9" }),
      },
    ],
  ])("refuses %s", (_, values: Record<string, string>) => {
    expect(parseHandoff(headersOf(values), ["7"])).toBeNull();
  });
});

describe("appTokenClientCode", () => {
  it("decodes a payload written in standard base64", () => {
    const payload = Buffer.from(
      JSON.stringify({ LoginId: "TEST0001", pad: "??>>" }),
    )
      .toString("base64")
      .replace(/=+$/, "");
    expect(appTokenClientCode(`a.${payload}.c`)).toBe("TEST0001");
  });

  it.each(["", "a", "a.!!!.c", `a.${b64("text")}.c`])(
    "returns null for %j",
    (token) => {
      expect(appTokenClientCode(token)).toBeNull();
    },
  );
});

describe("hasHandoffHeaders", () => {
  it("is true when either header is present", () => {
    expect(hasHandoffHeaders(headersOf({ "x-bigul-platform": "" }))).toBe(true);
    expect(hasHandoffHeaders(headersOf({ "x-bigul-token": "t" }))).toBe(true);
    expect(hasHandoffHeaders(headersOf({ accept: "text/html" }))).toBe(false);
  });
});

describe("hasTokenInQuery", () => {
  it.each(["token", "ACCESS_TOKEN", "sessionid", "platform", "client_code"])(
    "flags %s",
    (key) => {
      expect(hasTokenInQuery(new URLSearchParams({ [key]: "x" }))).toBe(true);
    },
  );

  it("allows next and a nonce", () => {
    expect(hasTokenInQuery(new URLSearchParams("next=%2F&n=123"))).toBe(false);
  });
});

describe("fetchMetadataProblem", () => {
  const request = (headers: Record<string, string>) =>
    new NextRequest("https://bigul-ai.vercel.app/auth/mobile", {
      headers: { host: "bigul-ai.vercel.app", ...headers },
    });

  it.each([
    ["no fetch metadata (older WebViews)", {}],
    [
      "an app-initiated top-level load",
      { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
    ],
    ["a same-origin Origin", { origin: "https://bigul-ai.vercel.app" }],
    [
      "the forwarded host behind a proxy",
      { origin: "https://chat.example", "x-forwarded-host": "chat.example" },
    ],
  ])("accepts %s", (_, headers: Record<string, string>) => {
    expect(fetchMetadataProblem(request(headers))).toBeNull();
  });

  it.each([
    ["origin", { origin: "https://evil.example" }],
    ["origin", { origin: "null" }],
    ["origin", { origin: "not a url" }],
    ["mode", { "sec-fetch-mode": "cors" }],
    ["mode", { "sec-fetch-mode": "no-cors" }],
    ["site", { "sec-fetch-site": "cross-site" }],
    ["site", { "sec-fetch-site": "same-site" }],
  ])("refuses with %s", (reason, headers: Record<string, string>) => {
    expect(fetchMetadataProblem(request(headers))).toBe(reason);
  });
});

describe("mobileErrorRedirect", () => {
  it("303s to the error page with the code and a non-default next", () => {
    const response = mobileErrorRedirect(
      new NextRequest("https://bigul-ai.vercel.app/auth/mobile"),
      "denied",
      "/?threadId=abc",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/mobile/error");
    expect(location.searchParams.get("code")).toBe("denied");
    expect(location.searchParams.get("next")).toBe("/?threadId=abc");
  });
});

describe("mobileNotice", () => {
  it("is a small no-store HTML page without any sign-in link", async () => {
    const response = mobileNotice({
      status: 503,
      title: "We couldn't reach Bigul",
      message: "Please try again.",
      retryAfterSeconds: 30,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("30");
    const html = await response.text();
    expect(html).toContain("We couldn't reach Bigul");
    expect(html).not.toMatch(/<a\b|sign in/i);
  });
});
