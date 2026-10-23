// @vitest-environment node
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { resetPartnerSessionCache } from "@/lib/auth/bigul";
import { verifySessionToken } from "@/lib/auth/session";
import { BLANK_AUTH_ENV, testPrivateKeyPem } from "@/lib/auth/test-keys";
import { GET, maxDuration } from "./route";

const ORIGIN = "http://localhost:3000";
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// Shaped like Bigul's access_token: an HS256 JWT naming the client and our app.
const jwtFor = (clientCode: string) =>
  [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({
      tokenData: { app_key: "k", client_code: clientCode },
      exp: 4_102_444_800,
    }),
    "c2ln",
  ].join(".");
const TOKEN = jwtFor("Y09042341");
const STATE = "Qm9vdHN0cmFwLXN0YXRlLXZhbHVlLTMyLWJ5dGVzLXh4";

let pem: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  pem = testPrivateKeyPem();
});

beforeEach(() => {
  resetPartnerSessionCache();
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
  vi.stubEnv("BIGUL_API_BASE_URL", "https://bigul.test");
  vi.stubEnv("BIGUL_API_KEY", "k");
  vi.stubEnv("BIGUL_API_SECRET", "s");
  vi.stubEnv("BIGUL_PARTNER_CODE", "PARTNER01");
  vi.stubEnv("BIGUL_PARTNER_PASSWORD", "p");
  fetchMock = vi.fn(async (url: string) =>
    String(url).includes("/partner/auth/session-login")
      ? Response.json({
          status: true,
          data: {
            sessionId: "partner-1",
            expiryTime: new Date(Date.now() + 3_600_000).toISOString(),
          },
        })
      : Response.json({ status: true, data: [{ clientcode: "Y09042341" }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stateCookie(
  overrides: Record<string, unknown> = {},
  name = "bigul_sso_state",
) {
  const value = JSON.stringify({
    state: STATE,
    sid: "0123456789abcdef0123456789abcdef",
    next: "/?threadId=abc",
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  });
  return `${name}=${encodeURIComponent(value)}`;
}

function callback(query: string, cookie: string | null = stateCookie()) {
  return GET(
    new NextRequest(`${ORIGIN}/auth/callback${query ? `?${query}` : ""}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

const success = (token = TOKEN, userid = "Y09042341") =>
  `login_success=true&userid=${userid}&state=${STATE}&token=${token}`;

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function expectStateCleared(response: Response) {
  const cleared = setCookies(response).find((cookie) =>
    cookie.startsWith("bigul_sso_state="),
  );
  expect(cleared).toMatch(/^bigul_sso_state=;/);
  expect(cleared).toMatch(/; Path=\/(;|$)/);
  expect(cleared).toContain("Max-Age=0");
}

function expectLoginError(response: Response, code: string) {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(`${ORIGIN}/login`);
  expect(location.searchParams.get("error")).toBe(code);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(
    setCookies(response).some((cookie) => cookie.startsWith("bigul_session=")),
  ).toBe(false);
  expectStateCleared(response);
}

describe("GET /auth/callback", () => {
  it("signs the client in from Bigul's documented redirect and returns them where they were", async () => {
    const response = await callback(success());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?threadId=abc`);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const profile = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("get-client-profile"),
    );
    expect(profile?.[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const session = setCookies(response).find((cookie) =>
      cookie.startsWith("bigul_session="),
    )!;
    expect(session).toContain("Path=/");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=lax");
    expect(session).toMatch(/Expires=\w{3}, \d{2} \w{3} \d{4} 19:00:00 GMT/);
    expect(session).not.toContain("Secure");
    const jwt = decodeURIComponent(session.split(";")[0].split("=")[1]);
    expect(await verifySessionToken(jwt)).toMatchObject({
      clientCode: "Y09042341",
    });
    expect(jwt).not.toContain(TOKEN);
    expectStateCleared(response);
  });

  it("signs the client in from the redirect production Bigul sends", async () => {
    // Seen on 23 Oct 2026: status, access_token and client_code.
    const response = await callback(
      `status=success&state=${STATE}&access_token=${TOKEN}&client_code=Y09042341`,
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?threadId=abc`);
    const profile = fetchMock.mock.calls.at(-1)!;
    expect(String(profile[0])).toContain("clientCode=Y09042341");
    expect(profile[1].method).toBe("GET");
    expect(profile[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a redirect edited to name another client, without calling Bigul", async () => {
    expectLoginError(
      await callback(
        `status=success&state=${STATE}&access_token=${TOKEN}&client_code=Y00000001`,
      ),
      "verify",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports status other than success as denied", async () => {
    expectLoginError(
      await callback(`status=failed&state=${STATE}&client_code=Y09042341`),
      "denied",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Secure, prefixed cookies in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await callback(
      success(),
      stateCookie({}, "__Host-bigul_sso_state"),
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?threadId=abc`);
    const [session, state] = setCookies(response);
    expect(session).toMatch(/^__Host-bigul_session=[^;]+;/);
    expect(session).toContain("Path=/;");
    expect(session).toContain("Secure");
    expect(session).not.toMatch(/Domain=/i);
    expect(state).toMatch(/^__Host-bigul_sso_state=;/);
    expect(state).toMatch(/; Path=\/(;|$)/);
    expect(state).toContain("Secure");
    expect(state).not.toMatch(/Domain=/i);
  });

  // A sibling subdomain can plant an unprefixed or __Secure- cookie, not __Host-.
  it.each(["bigul_sso_state", "__Secure-bigul_sso_state"])(
    "ignores a %s state cookie in production",
    async (name) => {
      vi.stubEnv("NODE_ENV", "production");
      const response = await callback(success(), stateCookie({}, name));
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("state");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a percent-encoded token and a lower-case, padded user id", async () => {
    const response = await callback(
      success(encodeURIComponent(TOKEN), "%20y09042341%20"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?threadId=abc`);
    const profile = fetchMock.mock.calls.at(-1)!;
    expect(String(profile[0])).toContain("clientCode=Y09042341");
    expect(profile[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads the query as Next re-serialises it for handlers", async () => {
    // URLSearchParams form of the same redirect: space as "+", "/" as %2F.
    const normalised = new URLSearchParams([
      ["login_success", "true"],
      ["userid", " y09042341"],
      ["state", STATE],
      // What URLSearchParams parsed from the raw "+": spaces.
      ["token", TOKEN.replace(/\+/g, " ")],
    ]).toString();
    expect(normalised).toContain("userid=+y09042341");

    const response = await callback(normalised);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?threadId=abc`);
    const profile = fetchMock.mock.calls.at(-1)!;
    expect(String(profile[0])).toContain("clientCode=Y09042341");
    expect(profile[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["no parameters", ""],
    ["login_success=false", `login_success=false&state=${STATE}`],
    ["a missing token", `login_success=true&userid=Y09042341&state=${STATE}`],
    ["a missing user id", `login_success=true&state=${STATE}&token=${TOKEN}`],
  ])("reports %s as denied", async (_, query) => {
    expectLoginError(await callback(query), "denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a missing state",
      `login_success=true&userid=Y09042341&token=${TOKEN}`,
      stateCookie(),
    ],
    ["a state mismatch", success().replace(STATE, `${STATE}x`), stateCookie()],
    ["a repeated state", `${success()}&state=${STATE}`, stateCookie()],
    ["no state cookie", success(), null],
    [
      "an expired state cookie",
      success(),
      stateCookie({ iat: Math.floor(Date.now() / 1000) - 601 }),
    ],
    ["a malformed state cookie", success(), "bigul_sso_state=not-json"],
  ])("reports %s as a state error", async (_, query, cookie) => {
    expectLoginError(await callback(query, cookie), "state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the saved destination on failure", async () => {
    const response = await callback(success().replace(STATE, "other"));
    expect(
      new URL(response.headers.get("location")!).searchParams.get("next"),
    ).toBe("/?threadId=abc");
  });

  it("reports a malformed user id as unverified without calling Bigul", async () => {
    expectLoginError(await callback(success(TOKEN, "Y1%3BDROP")), "verify");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports Bigul refusing the token as unverified", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("session-login")
        ? Response.json({
            status: true,
            data: { sessionId: "p", expiryTime: "2099-01-01T00:00:00Z" },
          })
        : Response.json({ status: false, message: "Invalid token." }),
    );
    expectLoginError(await callback(success()), "verify");
  });

  it("reports another client's profile as unverified", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("session-login")
        ? Response.json({
            status: true,
            data: { sessionId: "p", expiryTime: "2099-01-01T00:00:00Z" },
          })
        : Response.json({ status: true, data: [{ clientcode: "Y00000001" }] }),
    );
    expectLoginError(await callback(success()), "verify");
  });

  it("reports a network failure as Bigul unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expectLoginError(await callback(success()), "unavailable");
  });

  it.each([403, 429])(
    "reports a %i from the profile API as Bigul unavailable",
    async (status) => {
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("session-login")
          ? Response.json({
              status: true,
              data: { sessionId: "p", expiryTime: "2099-01-01T00:00:00Z" },
            })
          : Response.json({ status: false }, { status }),
      );
      expectLoginError(await callback(success()), "unavailable");
    },
  );

  it("gives Bigul's calls a minute before the platform cuts in", () => {
    expect(maxDuration).toBe(60);
  });

  it("reports missing signing configuration before using the token", async () => {
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", "");
    expectLoginError(await callback(success()), "config");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing Bigul API configuration", async () => {
    vi.stubEnv("BIGUL_API_SECRET", "");
    expectLoginError(await callback(success()), "config");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never redirects off-site, whatever the state cookie says", async () => {
    const response = await callback(
      success(),
      stateCookie({ next: "//evil.example/x" }),
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  });
});
