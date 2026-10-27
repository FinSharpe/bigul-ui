// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BigulUnavailableError, resetPartnerSessionCache } from "./bigul";
import { ConfigError } from "./config";
import {
  ConnectRefusedError,
  ConnectStateError,
  exchangeAppToken,
} from "./connect-bypass";
import {
  API_BASE,
  CONNECT,
  OUR_SITE,
  fakeBigul,
  type ConnectOutcome,
} from "./test-connect";
import { BLANK_AUTH_ENV } from "./test-keys";
import { appToken } from "./test-tokens";

// "+", "/" and "=" must reach Connect percent-encoded.
const APP_TOKEN = `${appToken({ LoginId: "TEST0001" })}+/=`;
const UA = "Mozilla/5.0 (Linux; Android 14) BigulApp/1.0";
const CALLBACK = new URL(`${OUR_SITE}/auth/callback`);

beforeEach(() => {
  resetPartnerSessionCache();
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SSO_APP_KEY", "k");
  vi.stubEnv("BIGUL_API_BASE_URL", API_BASE);
  vi.stubEnv("BIGUL_API_KEY", "k");
  vi.stubEnv("BIGUL_API_SECRET", "s");
  vi.stubEnv("BIGUL_PARTNER_CODE", "PARTNER01");
  vi.stubEnv("BIGUL_PARTNER_PASSWORD", "p");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(outcome: ConnectOutcome = "callback", clientCode?: string) {
  const fake = fakeBigul({ outcome, clientCode });
  vi.stubGlobal("fetch", fake.fetchMock);
  return fake;
}

const exchange = () =>
  exchangeAppToken({
    platform: "7",
    token: APP_TOKEN,
    userAgent: UA,
    callbackUrl: CALLBACK,
  });

describe("exchangeAppToken", () => {
  it("runs Connect's bypass chain and returns the client token it hands back", async () => {
    const fake = setup();
    await expect(exchange()).resolves.toEqual({
      clientCode: "TEST0001",
      // Read from the raw Location: Bigul tokens keep their "+".
      accessToken: fake.accessToken,
    });

    const calls = fake.connectCalls();
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/login",
      "/login-step",
      "/hand-back-step",
    ]);
    const first = new URL(calls[0].url);
    expect([...first.searchParams.keys()]).toEqual([
      "app_key",
      "sessionid",
      "state",
      "platform",
      "token",
    ]);
    expect(first.searchParams.get("app_key")).toBe("k");
    expect(first.searchParams.get("sessionid")).toBe("partner-1");
    expect(first.searchParams.get("platform")).toBe("7");
    expect(first.searchParams.get("token")).toBe(APP_TOKEN);
    expect(calls[0].url).toContain("%2B%2F%3D");
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(calls.every((call) => call.headers["User-Agent"] === UA)).toBe(true);
  });

  it("carries only the cookies Connect set, and none on the first request", async () => {
    const fake = setup();
    await exchange();
    const [first, ...rest] = fake.connectCalls();
    expect(first.headers.Cookie).toBeUndefined();
    for (const call of rest)
      expect(call.headers.Cookie).toBe("_csrf=csrf-1; connect.sid=sid-1");
  });

  it("never requests the hand-back URL on our site", async () => {
    const fake = setup();
    await exchange();
    expect(
      fake.fetchMock.mock.calls.some(([url]) =>
        String(url).includes("bigul-ai.vercel.app"),
      ),
    ).toBe(false);
  });

  it("accepts Bigul's documented hand-back to the site root", async () => {
    const fake = setup("docs-shape");
    await expect(exchange()).resolves.toEqual({
      clientCode: "TEST0001",
      accessToken: fake.accessToken,
    });
  });

  it("uses a default User-Agent when the WebView sends none", async () => {
    const fake = setup();
    await exchangeAppToken({
      platform: "7",
      token: APP_TOKEN,
      callbackUrl: CALLBACK,
    });
    expect(fake.connectCalls()[0].headers["User-Agent"]).toMatch(/MayraAI/);
  });

  it.each([
    ["Connect's login page (token refused)", "login-page"],
    ["a failure status", "failed-status"],
    ["a hand-back without a token", "no-access-token"],
    ["a hand-back to another path", "elsewhere"],
    ["a hand-back to another host", "foreign-host"],
    ["a hand-back over plain http", "insecure"],
  ] as const)("refuses %s", async (_, outcome) => {
    setup(outcome);
    await expect(exchange()).rejects.toBeInstanceOf(ConnectRefusedError);
  });

  it("rejects a hand-back with another state", async () => {
    setup("bad-state");
    await expect(exchange()).rejects.toBeInstanceOf(ConnectStateError);
  });

  it.each(["503", "429"] as const)(
    "reports a %s from Connect as unavailable",
    async (outcome) => {
      setup(outcome);
      await expect(exchange()).rejects.toBeInstanceOf(BigulUnavailableError);
    },
  );

  it("stops after five Connect redirects", async () => {
    const fake = setup("loop");
    await expect(exchange()).rejects.toBeInstanceOf(BigulUnavailableError);
    expect(fake.connectCalls()).toHaveLength(6);
  });

  it("reports a network failure as unavailable", async () => {
    const fake = setup();
    fake.fetchMock.mockImplementation(async (input) => {
      if (String(input).startsWith(CONNECT))
        throw new TypeError("fetch failed");
      return Response.json({
        status: true,
        data: { sessionId: "partner-1", expiryTime: "2999-01-01T00:00:00Z" },
      });
    });
    await expect(exchange()).rejects.toBeInstanceOf(BigulUnavailableError);
  });

  it("needs the SSO app key", async () => {
    setup();
    vi.stubEnv("BIGUL_SSO_APP_KEY", "");
    await expect(exchange()).rejects.toBeInstanceOf(ConfigError);
  });

  it("never logs the app token or the returned token", async () => {
    const fake = setup("login-page");
    await expect(exchange()).rejects.toThrow();
    setup("bad-state");
    await expect(exchange()).rejects.toThrow();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(APP_TOKEN.slice(0, 40));
    expect(logged).not.toContain(fake.accessToken.slice(0, 40));
  });
});
