// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { GET as expired } from "../expired/route";

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
