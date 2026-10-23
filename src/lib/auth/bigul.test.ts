// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BigulUnavailableError,
  BigulVerifyError,
  resetPartnerSessionCache,
  ssoSessionId,
  verifyBigulLogin,
} from "./bigul";
import { ConfigError } from "./config";
import { BLANK_AUTH_ENV } from "./test-keys";

const BASE = "https://bigul.test";
const SECRETS = {
  BIGUL_API_KEY: "api-key-k1",
  BIGUL_API_SECRET: "api-secret-s2",
  BIGUL_PARTNER_CODE: "PARTNER01",
  BIGUL_PARTNER_PASSWORD: "partner-password-p3",
};
const SESSION_PATH = "/partner/auth/session-login";
const PROFILE_PATH = "/auth/connect/get-client-profile";
const MARGIN_PATH = "/order/user-margin";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token shaped like Bigul's access_token (HS256 JWT; we never check the signature). */
function bigulToken({
  clientCode = "Y09042341",
  appKey = SECRETS.BIGUL_API_KEY,
  exp = 4_102_444_800, // 2100-01-01
}: { clientCode?: string; appKey?: string; exp?: number } = {}) {
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({
      tokenData: { app_key: appKey, client_code: clientCode, type: "CLIENT" },
      iat: 1_792_736_875,
      exp,
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}
const TOKEN = bigulToken();

type Call = { url: string; init: RequestInit };
let calls: Call[];
let sessionCount: number;
let fetchMock: ReturnType<typeof vi.fn>;

const path = (call: Call) =>
  new URL(call.url).pathname.replace(/^\/api\/v1/, "");
const sessionCalls = () => calls.filter((call) => path(call) === SESSION_PATH);

function sessionOk(
  expiryTime = new Date(Date.now() + 3_600_000).toISOString(),
) {
  sessionCount += 1;
  return Response.json({
    status: true,
    message: "Session created successfully.",
    data: { sessionId: `partner-session-${sessionCount}`, expiryTime },
  });
}

// Bigul pads the code with a space (seen on production).
function profileOk(clientcode = "Y09042341 ") {
  return Response.json({
    status: true,
    message: "Profile info fetched successfully.",
    data: [{ clientcode, name: "A CLIENT" }],
  });
}

const refused = () =>
  Response.json({ status: false, message: "Invalid token." });
const httpError =
  (status: number, message = "Bigul error") =>
  () =>
    Response.json({ message }, { status });

const htmlOutage = () =>
  new Response("<!doctype html><h1>503 Service Unavailable</h1>", {
    status: 503,
    headers: { "Content-Type": "text/html" },
  });

function route(handlers: {
  session?: () => Response | Promise<Response>;
  profile?: (call: Call) => Response | Promise<Response>;
  margin?: (call: Call) => Response | Promise<Response>;
}) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (path(call) === SESSION_PATH)
      return (handlers.session ?? (() => sessionOk()))();
    if (path(call) === PROFILE_PATH)
      return (handlers.profile ?? (() => profileOk()))(call);
    if (path(call) === MARGIN_PATH)
      return (
        handlers.margin ??
        (() => Response.json({ status: true, message: "Request successful." }))
      )(call);
    throw new Error(`unexpected ${url}`);
  });
}

const verify = (userid = "Y09042341", token = TOKEN) =>
  verifyBigulLogin({ userid, token });

beforeEach(() => {
  calls = [];
  sessionCount = 0;
  resetPartnerSessionCache();
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_API_BASE_URL", BASE);
  vi.stubEnv("BIGUL_VERIFY_WITH", "");
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  route({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("verifyBigulLogin", () => {
  it("makes one GET to the client profile, as Bigul's contract, and returns the client code", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await expect(verify(" y09042341 ")).resolves.toEqual({
      clientCode: "Y09042341",
    });

    expect(calls).toHaveLength(1);
    const [profile] = calls;
    expect(profile.url).toBe(
      `${BASE}${PROFILE_PATH}?clientCode=Y09042341&source=B2B`,
    );
    expect(profile.init.method).toBe("GET");
    expect(profile.init.headers).toEqual({
      "x-api-key": SECRETS.BIGUL_API_KEY,
      "x-api-secret": SECRETS.BIGUL_API_SECRET,
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(profile.init.body).toBeUndefined();
    expect(profile.init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("defaults to Bigul's production partner API, /api/v1 included", async () => {
    vi.stubEnv("BIGUL_API_BASE_URL", "");
    await verify();
    expect(calls.map((call) => call.url)).toEqual([
      `https://papi.bigul.co/api/v1${PROFILE_PATH}?clientCode=Y09042341&source=B2B`,
    ]);
  });

  it("uses the configured source", async () => {
    vi.stubEnv("BIGUL_API_SOURCE", "B2C");
    await verify();
    expect(calls[0].url).toContain("source=B2C");
  });

  it.each([
    ["a malformed client code", "Y 1", TOKEN],
    ["a token with a space", "Y1", "s 4xF"],
    ["an empty token", "Y1", ""],
    ["a token that is not a JWT", "Y09042341", "s+4xF+iIYJU9emMt+8DY/GU="],
    [
      "a token whose payload is not JSON",
      "Y09042341",
      `${b64({ alg: "HS256" })}.bm90LWpzb24.c2ln`,
    ],
    [
      "a token for another client",
      "Y09042341",
      bigulToken({ clientCode: "Y00000001" }),
    ],
    ["a token for another app", "Y09042341", bigulToken({ appKey: "other" })],
    ["an expired token", "Y09042341", bigulToken({ exp: 1_000_000_000 })],
  ])("refuses %s without calling Bigul", async (_, userid, token) => {
    await expect(verify(userid, token)).rejects.toBeInstanceOf(
      BigulVerifyError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs the API credentials", async () => {
    vi.stubEnv("BIGUL_API_SECRET", "");
    await expect(verify()).rejects.toBeInstanceOf(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls Bigul directly with the global fetch when no relay is set", async () => {
    vi.stubEnv("BIGUL_OUTBOUND_PROXY_URLS", "  ");
    await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });
    expect(Object.keys(calls[0].init).sort()).toEqual([
      "headers",
      "method",
      "signal",
    ]);
  });

  it("refuses a malformed BIGUL_OUTBOUND_PROXY_URLS before calling Bigul", async () => {
    vi.stubEnv(
      "BIGUL_OUTBOUND_PROXY_URLS",
      "http://bigul:pa#ss@203.0.113.10:3128",
    );
    await expect(verify()).rejects.toBeInstanceOf(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("profile answers", () => {
  it.each([
    [
      "Bigul's client_code mismatch",
      httpError(401, "Token authenticate error (client_code mismatch)"),
      "unauthorized",
    ],
    ["a 401", httpError(401), "unauthorized"],
    ["status false", refused, "refused"],
    [
      "another client's profile",
      () => profileOk("Y00000001"),
      "profile mismatch",
    ],
    [
      "no profile rows",
      () => Response.json({ status: true, data: [] }),
      "profile mismatch",
    ],
  ])("does not verify %s", async (_, profile, reason) => {
    route({ profile });
    await expect(verify()).rejects.toBeInstanceOf(BigulVerifyError);
    expect(console.error).toHaveBeenCalledWith(
      "[bigul-auth] client login not verified",
      expect.objectContaining({ reason }),
    );
  });

  it.each([
    [
      "a 403 (API key/secret or IP)",
      httpError(403),
      403,
      "forbidden: API key/secret or IP not authorized",
    ],
    ["a 400", httpError(400), 400, "bad request"],
    ["a 404", httpError(404), 404, "unexpected status"],
    ["a 429", httpError(429), 429, "rate limited"],
    ["an HTML 503", htmlOutage, 503, "server error"],
    ["a non-JSON 200", () => new Response("ok"), 200, "unexpected response"],
    [
      "a 200 without a status flag",
      () => Response.json({ data: [{ clientcode: "Y09042341" }] }),
      200,
      "unexpected response",
    ],
  ])("reports Bigul unavailable for %s", async (_, profile, status, reason) => {
    route({ profile });
    await expect(verify()).rejects.toBeInstanceOf(BigulUnavailableError);
    expect(console.error).toHaveBeenCalledWith(
      "[bigul-auth] client profile unavailable",
      expect.objectContaining({ status, reason }),
    );
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a timeout",
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ],
    [
      "a body cut off by the timeout",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("timed out", "TimeoutError"));
            },
          }),
          { status: 200 },
        ),
    ],
  ])("reports Bigul unavailable for %s", async (_, profile) => {
    route({ profile });
    await expect(verify()).rejects.toBeInstanceOf(BigulUnavailableError);
    expect(console.error).toHaveBeenCalledWith(
      "[bigul-auth] client profile request failed",
      { reason: expect.any(String) },
    );
  });
});

describe("margin fallback (BIGUL_VERIFY_WITH=margin)", () => {
  beforeEach(() => vi.stubEnv("BIGUL_VERIFY_WITH", "margin"));

  it("asks for a one-share margin calculation with the client's token", async () => {
    await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });
    expect(calls).toHaveLength(1);
    const [margin] = calls;
    expect(margin.url).toBe(`${BASE}${MARGIN_PATH}`);
    expect(margin.init.method).toBe("POST");
    expect(margin.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(String(margin.init.body))).toMatchObject({
      source: "B2B",
      clientCode: "Y09042341",
      qty: "1",
    });
  });

  it("still refuses a token for another client without calling Bigul", async () => {
    await expect(
      verify("Y09042341", bigulToken({ clientCode: "Y00000001" })),
    ).rejects.toBeInstanceOf(BigulVerifyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a 401", httpError(401), BigulVerifyError],
    ["status false", refused, BigulVerifyError],
    ["a 503", htmlOutage, BigulUnavailableError],
  ])("handles %s", async (_, margin, error) => {
    route({ margin });
    await expect(verify()).rejects.toBeInstanceOf(error);
  });
});

describe("ssoSessionId (partner session for the login link)", () => {
  it("logs the partner in with the contract's request", async () => {
    await expect(ssoSessionId()).resolves.toBe("partner-session-1");
    const [session] = sessionCalls();
    expect(session.url).toBe(`${BASE}${SESSION_PATH}`);
    expect(session.init.method).toBe("POST");
    expect(session.init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": SECRETS.BIGUL_API_KEY,
      "x-api-secret": SECRETS.BIGUL_API_SECRET,
    });
    expect(JSON.parse(String(session.init.body))).toEqual({
      source: "B2B",
      code: SECRETS.BIGUL_PARTNER_CODE,
      password: SECRETS.BIGUL_PARTNER_PASSWORD,
    });
  });

  it("reuses the partner session until five minutes before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
    route({ session: () => sessionOk("2026-10-21T10:10:00.000Z") });

    await ssoSessionId();
    vi.setSystemTime(new Date("2026-10-21T10:04:59Z"));
    await expect(ssoSessionId()).resolves.toBe("partner-session-1");
    expect(sessionCalls()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-10-21T10:05:00Z"));
    await expect(ssoSessionId()).resolves.toBe("partner-session-2");
    expect(sessionCalls()).toHaveLength(2);
  });

  it("does not cache a partner session without a usable expiry", async () => {
    route({ session: () => sessionOk("soon") });
    await ssoSessionId();
    await ssoSessionId();
    expect(sessionCalls()).toHaveLength(2);
  });

  it("shares one partner login between concurrent sign-ins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    route({
      session: async () => {
        await gate;
        return sessionOk();
      },
    });
    const ids = Promise.all([ssoSessionId(), ssoSessionId(), ssoSessionId()]);
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
    release();
    await expect(ids).resolves.toEqual([
      "partner-session-1",
      "partner-session-1",
      "partner-session-1",
    ]);
  });

  it("does not keep a failed partner login", async () => {
    let fail = true;
    route({ session: () => (fail ? htmlOutage() : sessionOk()) });
    await expect(ssoSessionId()).rejects.toBeInstanceOf(BigulUnavailableError);
    fail = false;
    await expect(ssoSessionId()).resolves.toBe("partner-session-1");
    expect(sessionCalls()).toHaveLength(2);
  });

  it.each([
    ["an HTML 503", () => htmlOutage()],
    [
      "a refused partner login",
      () => Response.json({ status: false, message: "Invalid credentials" }),
    ],
    ["an IP/key denial", httpError(403)],
    [
      "a timeout",
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ],
  ])("reports Bigul unavailable for %s", async (_, session) => {
    route({ session });
    await expect(ssoSessionId()).rejects.toBeInstanceOf(BigulUnavailableError);
  });

  it("needs the partner credentials", async () => {
    vi.stubEnv("BIGUL_PARTNER_PASSWORD", "");
    await expect(ssoSessionId()).rejects.toBeInstanceOf(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("logging", () => {
  it("logs Bigul's message with the status when the partner login is refused", async () => {
    route({
      session: () => Response.json({ status: false, message: "Invalid TOTP." }),
    });
    await expect(ssoSessionId()).rejects.toBeInstanceOf(BigulUnavailableError);
    expect(console.error).toHaveBeenCalledWith(
      "[bigul-auth] partner session login rejected",
      { status: 200, message: "Invalid TOTP." },
    );
  });

  it("logs Bigul's message with the status when the profile is refused", async () => {
    route({ profile: refused });
    await expect(verify()).rejects.toBeInstanceOf(BigulVerifyError);
    expect(console.error).toHaveBeenCalledWith(
      "[bigul-auth] client login not verified",
      { status: 200, message: "Invalid token.", reason: "refused" },
    );
  });

  it("logs only a short string message without control characters", async () => {
    const message = `bad\u0000\n\r\u001b[31m token ${"x".repeat(300)}`;
    route({ profile: () => Response.json({ status: false, message }) });
    await verify().catch(() => {});
    const [, detail] = vi.mocked(console.error).mock.calls.at(-1)!;
    expect(detail.message).toHaveLength(200);
    expect(detail.message).toMatch(/^bad\[31m token x+$/);

    route({
      profile: () => Response.json({ status: false, message: { text: "x" } }),
    });
    await verify().catch(() => {});
    expect(vi.mocked(console.error).mock.calls.at(-1)![1]).toEqual({
      status: 200,
      reason: "refused",
    });
  });

  it("never logs the token, the partner password, the API key or secret, or the partner session", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const echo = `token ${TOKEN} key ${SECRETS.BIGUL_API_KEY} secret ${SECRETS.BIGUL_API_SECRET}`;
    const verifyScenarios = [
      { profile: httpError(401, echo) },
      { profile: () => htmlOutage() },
      { profile: () => Promise.reject(new TypeError(`fetch failed ${TOKEN}`)) },
      { profile: () => profileOk("OTHER") },
      { profile: () => Response.json({ status: false, message: echo }) },
    ];
    for (const handlers of verifyScenarios) {
      route(handlers);
      await verify().catch(() => {});
    }
    const sessionScenarios = [
      { session: httpError(403) },
      { session: () => Promise.reject(new TypeError("fetch failed")) },
      {
        session: () =>
          Response.json({
            status: false,
            message: `password ${SECRETS.BIGUL_PARTNER_PASSWORD} secret ${SECRETS.BIGUL_API_SECRET} session partner-session-9`,
            data: { sessionId: "partner-session-9" },
          }),
      },
    ];
    for (const handlers of sessionScenarios) {
      resetPartnerSessionCache();
      route(handlers);
      await ssoSessionId().catch(() => {});
    }
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).toContain("[redacted]");
    for (const secret of [
      TOKEN,
      SECRETS.BIGUL_PARTNER_PASSWORD,
      SECRETS.BIGUL_API_SECRET,
      SECRETS.BIGUL_API_KEY,
      "partner-session-",
    ])
      expect(logged).not.toContain(secret);
  });
});
