// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BLANK_AUTH_ENV } from "@/lib/auth/test-keys";
import { BigulUnavailableError, ssoSessionId } from "@/lib/auth/bigul";
import { GET } from "./route";

vi.mock("@/lib/auth/bigul", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/bigul")>()),
  ssoSessionId: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

beforeEach(() => {
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SSO_APP_KEY", "app-key-1");
  vi.mocked(ssoSessionId).mockResolvedValue("partner-session-1");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(ssoSessionId).mockReset();
});

const login = (query = "") =>
  GET(new NextRequest(`${ORIGIN}/auth/login${query}`));

function savedState(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("bigul_sso_state="))!;
  return {
    cookie,
    value: JSON.parse(decodeURIComponent(cookie.split(";")[0].split("=")[1])),
  };
}

describe("GET /auth/login", () => {
  it("sends the browser to Bigul with app_key, sessionid and state", async () => {
    const response = await login("?next=%2F%3FthreadId%3Dabc");

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const target = new URL(response.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(
      "https://connect.bigul.co/login",
    );
    expect([...target.searchParams.keys()]).toEqual([
      "app_key",
      "sessionid",
      "state",
    ]);
    expect(target.searchParams.get("app_key")).toBe("app-key-1");
    // Bigul's login page accepts only our live partner session here.
    expect(target.searchParams.get("sessionid")).toBe("partner-session-1");
    expect(target.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { cookie, value } = savedState(response);
    expect(value).toMatchObject({
      state: target.searchParams.get("state"),
      next: "/?threadId=abc",
    });
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
  });

  it("names the state cookie __Host- in production: Secure, Path=/, no Domain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const [cookie] = (await login()).headers.getSetCookie();
    expect(cookie).toMatch(/^__Host-bigul_sso_state=/);
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toContain("Secure");
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("uses a fresh state every time", async () => {
    const first = savedState(await login()).value.state;
    const second = savedState(await login()).value.state;
    expect(first).not.toBe(second);
  });

  it("uses the configured Bigul login URL", async () => {
    vi.stubEnv("BIGUL_SSO_LOGIN_URL", "http://127.0.0.1:3300/login");
    const target = new URL((await login()).headers.get("location")!);
    expect(target.origin + target.pathname).toBe("http://127.0.0.1:3300/login");
  });

  it.each(["//evil.example", "https://evil.example/", "/auth/login"])(
    "replaces the unsafe destination %j with /",
    async (next) => {
      const response = await login(`?next=${encodeURIComponent(next)}`);
      expect(savedState(response).value.next).toBe("/");
    },
  );

  it("reports missing configuration on the login page", async () => {
    vi.stubEnv("BIGUL_SSO_APP_KEY", "");
    const response = await login("?next=%2F%3Fa%3D1");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("config");
    expect(location.searchParams.get("next")).toBe("/?a=1");
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /auth/login when Bigul is unreachable", () => {
  it("reports Bigul unavailable when the partner login fails", async () => {
    vi.mocked(ssoSessionId).mockRejectedValue(
      new BigulUnavailableError("Partner session login rejected"),
    );
    const response = await login("?next=%2F%3Fa%3D1");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("unavailable");
    expect(location.searchParams.get("next")).toBe("/?a=1");
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
