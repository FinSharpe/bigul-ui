import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginNavigation, resetAuthRedirect } from "@/lib/auth-fetch";
import { createClient } from "./client";

const fetchMock = vi.fn();
let assign: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetAuthRedirect();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  assign = vi.spyOn(loginNavigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createClient", () => {
  it("routes SDK requests through authFetch, so a 401 leads to sign-in", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
    const client = createClient(
      `${window.location.origin}/api`,
      undefined,
      undefined,
    );
    await expect(client.threads.search({ limit: 1 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${window.location.origin}/api/threads/search`,
    );
    expect(assign).toHaveBeenCalledOnce();
  });

  it("returns SDK results unchanged when signed in", async () => {
    fetchMock.mockResolvedValue(Response.json([{ thread_id: "t1" }]));
    const client = createClient(`${window.location.origin}/api`, "k", "s");
    await expect(client.threads.search({ limit: 1 })).resolves.toEqual([
      { thread_id: "t1" },
    ]);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("x-auth-scheme")).toBe("s");
    expect(assign).not.toHaveBeenCalled();
  });
});
