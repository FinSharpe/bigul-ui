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
import {
  getRedirectUrl,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server";
import { mintSession } from "@/lib/auth/session";
import { BLANK_AUTH_ENV, testPrivateKeyPem } from "@/lib/auth/test-keys";
import { config, proxy } from "./proxy";

const ORIGIN = "http://localhost:3000";
let pem: string;
let jwt: string;

beforeAll(() => {
  pem = testPrivateKeyPem();
});

beforeEach(async () => {
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
  jwt = (await mintSession("Y09042341")).token;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(
  path: string,
  init: { method?: string; cookie?: string } = {},
) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: init.cookie ? { cookie: init.cookie } : {},
  });
}

const passes = (response: Response) =>
  response.headers.get("x-middleware-next") === "1";

describe("proxy", () => {
  it("sends a signed-out page visit to the login page with its path", async () => {
    const response = await proxy(
      request("/?threadId=abc&chatHistoryOpen=true"),
    );
    expect(response.status).toBe(307);
    const location = new URL(getRedirectUrl(response)!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(
      "/?threadId=abc&chatHistoryOpen=true",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a signed-out API call with 401 JSON", async () => {
    const response = await proxy(
      request("/api/threads/search", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it.each([
    ["an invalid", "bigul_session=not-a-jwt"],
    ["another app's", "session=whatever"],
  ])("treats %s cookie as signed out", async (_, cookie) => {
    expect((await proxy(request("/api/info", { cookie }))).status).toBe(401);
    expect((await proxy(request("/", { cookie }))).status).toBe(307);
  });

  it("lets a signed-in client through to pages and the API", async () => {
    const cookie = `bigul_session=${jwt}`;
    expect(passes(await proxy(request("/", { cookie })))).toBe(true);
    expect(passes(await proxy(request("/api/threads", { cookie })))).toBe(true);
  });

  it("reads only the __Host- session cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const plain = `bigul_session=${jwt}`;
    expect((await proxy(request("/api/info", { cookie: plain }))).status).toBe(
      401,
    );
    const prefixed = `__Host-bigul_session=${jwt}`;
    expect(passes(await proxy(request("/", { cookie: prefixed })))).toBe(true);
  });

  it.each([
    "/login",
    "/login?error=state",
    "/auth/login",
    "/auth/callback?x=1",
  ])("lets %s through without a session", async (path) => {
    expect(passes(await proxy(request(path)))).toBe(true);
  });

  it("lets CORS preflight through", async () => {
    expect(
      passes(await proxy(request("/api/threads", { method: "OPTIONS" }))),
    ).toBe(true);
  });

  it("forwards Bigul's root redirect to the callback with the raw query", async () => {
    const query =
      "login_success=true&userid=Y09042341&state=abc_DEF-1&token=s+4xF+iIYJU9emMt+8DY/GU=";
    const response = await proxy(request(`/?${query}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/auth/callback?${query}`,
    );
  });

  it("forwards production Bigul's root redirect (status, access_token, client_code)", async () => {
    const query =
      "status=success&state=abc_DEF-1&access_token=aGVhZA.Ym9keQ.c2ln&client_code=Y09042341";
    const response = await proxy(request(`/?${query}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/auth/callback?${query}`,
    );
  });

  it("forwards a denied root redirect too", async () => {
    const response = await proxy(request("/?login_success=false&state=abc"));
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/auth/callback?login_success=false&state=abc`,
    );
  });
});

describe("proxy matcher", () => {
  const matches = (url: string) =>
    unstable_doesMiddlewareMatch({ config, url });

  it.each([
    "/",
    "/?threadId=abc",
    "/login",
    "/auth/callback",
    "/api/threads",
    "/api/threads/abc/runs/stream",
    "/api/api/filings/pdf",
  ])("runs for %s", (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/main.js",
    "/_next/image?url=x",
    "/favicon.ico",
    "/fonts/report/Inter-400.subset.woff2",
    "/robots.txt",
    "/logo.png",
  ])("skips the static asset %s", (url) => {
    expect(matches(url)).toBe(false);
  });
});
