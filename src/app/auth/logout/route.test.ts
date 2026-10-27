// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

function logout(headers: Record<string, string>) {
  return POST(
    new NextRequest("http://localhost:3000/auth/logout", {
      method: "POST",
      headers: { host: "localhost:3000", ...headers },
    }),
  );
}

describe("POST /auth/logout", () => {
  it("clears the session and returns to the login page for a same-origin form", async () => {
    const response = await logout({ origin: "http://localhost:3000" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^bigul_session=;/);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
  });

  it("clears the __Host- session cookie, Secure, in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await logout({ origin: "http://localhost:3000" });
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^__Host-bigul_session=;/);
    expect(cookie).toContain("Path=/;");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=0");
  });

  it("compares against the forwarded host behind a proxy", async () => {
    const response = await logout({
      origin: "https://chat.bigul.example",
      "x-forwarded-host": "chat.bigul.example",
    });
    expect(response.status).toBe(303);
  });

  it.each([
    ["a cross-site Origin", { origin: "https://evil.example" }],
    ["a missing Origin", {}],
    ["an opaque Origin", { origin: "null" }],
    ["a malformed Origin", { origin: "not a url" }],
  ])("refuses %s", async (_, headers: Record<string, string>) => {
    const response = await logout(headers);
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("POST /auth/logout inside the Bigul app", () => {
  it("clears the session but keeps the app marker and avoids the sign-in page", async () => {
    const response = await logout({
      origin: "http://localhost:3000",
      cookie: "bigul_embedded=1",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/mobile/expired",
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^bigul_session=;/);
  });
});
