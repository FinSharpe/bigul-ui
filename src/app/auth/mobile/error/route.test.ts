// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { GET as expiredRoute } from "../expired/route";
import { appCookieName } from "@/lib/auth/session";

const withApp = (url: string, theme?: string) =>
  new NextRequest(url, {
    headers: theme ? { cookie: `${appCookieName()}=${theme}` } : {},
  });
const expired = (theme?: string) =>
  expiredRoute(
    withApp("https://bigul-ai.vercel.app/auth/mobile/expired", theme),
  );

const page = (query: string) =>
  GET(new NextRequest(`https://bigul-ai.vercel.app/auth/mobile/error${query}`));

describe("GET /auth/mobile/error", () => {
  it.each([
    ["missing", 400],
    ["denied", 401],
    ["state", 401],
    ["mismatch", 401],
    ["verify", 401],
    ["unavailable", 503],
    ["config", 500],
  ])("answers %s with %i", async (code, status) => {
    const response = page(`?code=${code}`);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("asks the app to retry later when Bigul is unreachable", () => {
    expect(page("?code=unavailable").headers.get("retry-after")).toBe("30");
  });

  it.each(["", "?code=__proto__", "?code=<script>"])(
    "treats %j as a generic error",
    async (query) => {
      const response = page(query);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("<script>");
    },
  );

  it("never offers a sign-in link", async () => {
    for (const code of ["denied", "verify", "unavailable", "config"]) {
      const html = await page(`?code=${code}`).text();
      expect(html).not.toMatch(/<a\b|sign in/i);
    }
    expect(await page("?code=denied").text()).toContain(
      "open it again from the Bigul app",
    );
  });
});

describe("GET /auth/mobile/expired", () => {
  it("is a 401 page asking to reopen Mayra, with no sign-in link", async () => {
    const response = expired();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("open it again from the Bigul app");
    expect(html).not.toMatch(/<a\b|sign in/i);
  });
});

describe("app theme on the notice pages", () => {
  const error = (theme?: string) =>
    GET(
      withApp(
        "https://bigul-ai.vercel.app/auth/mobile/error?code=denied",
        theme,
      ),
    );

  it("draws the Super App's pages dark from its app cookie", async () => {
    expect(await error("superapp").text()).toContain("background:#01030d");
    expect(await expired("superapp").text()).toContain("background:#01030d");
  });

  it("keeps the default look without the cookie or with an unknown value", async () => {
    for (const theme of [undefined, "bigul", "other"]) {
      expect(await error(theme).text()).toContain("background:#f4f5f7");
      expect(await expired(theme).text()).toContain("background:#f4f5f7");
    }
  });
});
