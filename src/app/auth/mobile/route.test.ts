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
import { mintSession, verifySessionToken } from "@/lib/auth/session";
import {
  API_BASE,
  fakeBigul,
  type FakeBigulOptions,
} from "@/lib/auth/test-connect";
import { BLANK_AUTH_ENV, testPrivateKeyPem } from "@/lib/auth/test-keys";
import { appToken } from "@/lib/auth/test-tokens";
import * as route from "./route";

const { GET, HEAD } = route;
const ORIGIN = "https://bigul-ai.vercel.app";
const APP_TOKEN = appToken({ LoginId: "TEST0001", unique_name: "TEST0001" });
const HANDOFF = { "x-bigul-platform": "7", "x-bigul-token": APP_TOKEN };

let pem: string;
let fake: ReturnType<typeof fakeBigul>;

beforeAll(() => {
  pem = testPrivateKeyPem();
});

function useBigul(options: FakeBigulOptions = {}) {
  fake = fakeBigul(options);
  vi.stubGlobal("fetch", fake.fetchMock);
}

beforeEach(() => {
  resetPartnerSessionCache();
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
  vi.stubEnv("BIGUL_SSO_APP_KEY", "k");
  vi.stubEnv("BIGUL_SSO_PLATFORMS", "7");
  vi.stubEnv("BIGUL_API_BASE_URL", API_BASE);
  vi.stubEnv("BIGUL_API_KEY", "k");
  vi.stubEnv("BIGUL_API_SECRET", "s");
  vi.stubEnv("BIGUL_PARTNER_CODE", "PARTNER01");
  vi.stubEnv("BIGUL_PARTNER_PASSWORD", "p");
  useBigul();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mobile(
  query = "?next=%2F%3FthreadId%3Dabc&n=1",
  headers: Record<string, string> = HANDOFF,
) {
  return GET(
    new NextRequest(`${ORIGIN}/auth/mobile${query}`, {
      headers: {
        host: "bigul-ai.vercel.app",
        "user-agent": "BigulApp/1.0 (Android)",
        ...headers,
      },
    }),
  );
}

const cookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));

const sessionValue = (response: Response) =>
  decodeURIComponent(
    cookie(response, "bigul_session")!.split(";")[0].split("=")[1],
  );

function expectError(response: Response, code: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(
    `${ORIGIN}/auth/mobile/error`,
  );
  expect(location.searchParams.get("code")).toBe(code);
}

function expectSignedOutAndMarked(response: Response) {
  expect(cookie(response, "bigul_session")).toMatch(/^bigul_session=;/);
  expect(cookie(response, "bigul_session")).toContain("Max-Age=0");
  expect(cookie(response, "bigul_embedded")).toMatch(/^bigul_embedded=1;/);
}

const profileCalls = () =>
  fake.fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("get-client-profile"),
  );

describe("GET /auth/mobile", () => {
  it("exchanges the app token through Connect and opens the chat signed in", async () => {
    const response = await mobile();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?threadId=abc`);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const session = await verifySessionToken(sessionValue(response));
    expect(session?.clientCode).toBe("TEST0001");
    expect(cookie(response, "bigul_session")).toContain("HttpOnly");
    expect(cookie(response, "bigul_session")).toContain("SameSite=lax");

    const marker = cookie(response, "bigul_embedded")!;
    expect(marker).toMatch(/^bigul_embedded=1;/);
    expect(marker).toContain("HttpOnly");
    expect(marker).toContain("Max-Age=2592000");

    // The client token from Connect is verified like a web sign-in.
    const [[, init]] = profileCalls();
    expect(
      (init as RequestInit & { headers: Record<string, string> }).headers
        .Authorization,
    ).toBe(`Bearer ${fake.accessToken}`);
    // The WebView's own User-Agent reaches Connect.
    expect(fake.connectCalls()[0].headers["User-Agent"]).toBe(
      "BigulApp/1.0 (Android)",
    );
  });

  it("replaces a previous client's session on a shared phone", async () => {
    const previous = await mintSession("Y00000001");
    const response = await mobile(undefined, {
      ...HANDOFF,
      cookie: `bigul_session=${previous.token}`,
    });
    const session = await verifySessionToken(sessionValue(response));
    expect(session?.clientCode).toBe("TEST0001");
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({
      switched: true,
    });
  });

  it.each(["//evil.example", "/login", "/auth/mobile"])(
    "sends next=%j home",
    async (next) => {
      const response = await mobile(`?next=${encodeURIComponent(next)}`);
      expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    },
  );

  it.each(["token", "access_token", "sessionid", "platform", "client_code"])(
    "refuses a %s in the URL without touching cookies or Bigul",
    async (key) => {
      const response = await mobile(`?${key}=${APP_TOKEN}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(fake.fetchMock).not.toHaveBeenCalled();
    },
  );

  it("without headers shows the error page and leaves cookies alone", async () => {
    const response = await mobile(undefined, {});
    expectError(response, "missing");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a cross-site fetch", { "sec-fetch-mode": "cors" }],
    ["a cross-site navigation", { "sec-fetch-site": "cross-site" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
  ])("refuses %s before any cookie change", async (_, extra) => {
    const response = await mobile(undefined, { ...HANDOFF, ...extra });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a platform not allowed", { ...HANDOFF, "x-bigul-platform": "5" }],
    ["a missing token", { "x-bigul-platform": "7" }],
    ["a token naming no client", { ...HANDOFF, "x-bigul-token": appToken({}) }],
  ])("fails closed for %s", async (_, headers) => {
    const response = await mobile(undefined, headers);
    expectError(response, "missing");
    expectSignedOutAndMarked(response);
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing platform allowlist as a config error", async () => {
    vi.stubEnv("BIGUL_SSO_PLATFORMS", "");
    const response = await mobile();
    expectError(response, "config");
    expectSignedOutAndMarked(response);
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing signing key before spending the token", async () => {
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", "");
    const response = await mobile();
    expectError(response, "config");
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", "login-page"],
    ["denied", "failed-status"],
    ["state", "bad-state"],
    ["unavailable", "503"],
  ] as const)("answers %s when Connect gives %s", async (code, outcome) => {
    useBigul({ outcome });
    const previous = await mintSession("TEST0001");
    const response = await mobile(undefined, {
      ...HANDOFF,
      cookie: `bigul_session=${previous.token}`,
    });
    expectError(response, code);
    expectSignedOutAndMarked(response);
    expect(profileCalls()).toHaveLength(0);
  });

  it("refuses when Connect signs in a different client than the app token names", async () => {
    useBigul({ clientCode: "Y00000002" });
    const response = await mobile();
    expectError(response, "mismatch");
    expectSignedOutAndMarked(response);
    expect(profileCalls()).toHaveLength(0);
  });

  it.each([
    ["verify", "401"],
    ["unavailable", "503"],
  ] as const)(
    "answers %s when the profile check gives %s",
    async (code, profile) => {
      useBigul({ profile });
      const response = await mobile();
      expectError(response, code);
      expectSignedOutAndMarked(response);
    },
  );

  it("uses __Host- cookies in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await mobile();
    for (const name of ["__Host-bigul_session", "__Host-bigul_embedded"]) {
      const value = cookie(response, name)!;
      expect(value).toContain("Secure");
      expect(value).toContain("Path=/");
      expect(value).not.toMatch(/Domain=/i);
    }
  });

  it("never logs the tokens or the raw client code", async () => {
    await mobile();
    useBigul({ outcome: "login-page" });
    await mobile();
    useBigul({ clientCode: "Y00000002" });
    await mobile();
    const logged = JSON.stringify([
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain(APP_TOKEN.split(".")[1].slice(0, 24));
    expect(logged).not.toContain(fake.accessToken.split(".")[1].slice(0, 24));
    expect(logged).not.toContain("TEST0001");
    expect(logged).not.toContain("Y00000002");
  });

  it("accepts the hand-back at the redirect URL registered with Bigul, not just this host", async () => {
    // e.g. a preview deployment, whose own /auth/callback Bigul does not know.
    const preview = (env?: string) => {
      if (env) vi.stubEnv("BIGUL_SSO_REDIRECT_URL", env);
      return GET(
        new NextRequest("https://preview.example.app/auth/mobile", {
          headers: { host: "preview.example.app", ...HANDOFF },
        }),
      );
    };
    const refused = await preview();
    expect(refused.status).toBe(303);
    expect(
      new URL(refused.headers.get("location")!).searchParams.get("code"),
    ).toBe("denied");
    useBigul();
    const response = await preview(`${ORIGIN}/auth/callback`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://preview.example.app/",
    );
  });

  it("answers within its deadline when Bigul hangs, signing the previous client out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const real = fake.fetchMock.getMockImplementation()!;
      fake.fetchMock.mockImplementation((input, init) =>
        String(input).includes("get-client-profile")
          ? new Promise<Response>(() => {})
          : real(input, init),
      );
      const previous = await mintSession("Y00000001");
      let response: Response | undefined;
      const pending = mobile(undefined, {
        ...HANDOFF,
        cookie: `bigul_session=${previous.token}`,
      }).then((value) => (response = value));
      // Session crypto runs on real timers, so step until the route answers.
      for (let elapsed = 0; !response && elapsed < 20_000; elapsed += 500) {
        await vi.advanceTimersByTimeAsync(500);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await pending;
      expect(response).toBeDefined();
      expectError(response!, "unavailable");
      expect(
        vi
          .mocked(console.error)
          .mock.calls.some(([message]) =>
            String(message).includes("took too long"),
          ),
      ).toBe(true);
      expectSignedOutAndMarked(response!);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses HEAD instead of running a sign-in", async () => {
    const response = HEAD();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("exports only GET and HEAD, on Node, with room for the Bigul calls", () => {
    expect(Object.keys(route).sort()).toEqual(
      ["GET", "HEAD", "maxDuration", "runtime"].sort(),
    );
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(60);
  });
});
