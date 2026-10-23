import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch, loginNavigation, resetAuthRedirect } from "./auth-fetch";

const fetchMock = vi.fn();
let assign: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetAuthRedirect();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  assign = vi.spyOn(loginNavigation, "assign").mockImplementation(() => {});
  window.history.replaceState(null, "", "/?threadId=abc&chatHistoryOpen=true");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const respond = (status: number) =>
  fetchMock.mockResolvedValue(new Response(null, { status }));

describe("authFetch", () => {
  it("calls the current global fetch with the arguments unchanged", async () => {
    respond(200);
    const init = { method: "POST", headers: { "X-Test": "1" } };
    await authFetch("http://localhost:3000/api/threads/search", init);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/threads/search",
      init,
    );
    await authFetch("/api/info");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/info");
  });

  it("sends a 401 from this site's /api to sign-in once, keeping the page", async () => {
    respond(401);
    const response = await authFetch(`${window.location.origin}/api/threads`);
    expect(response.status).toBe(401);
    expect(assign).toHaveBeenCalledExactlyOnceWith(
      `/login?next=${encodeURIComponent("/?threadId=abc&chatHistoryOpen=true")}`,
    );

    await authFetch("/api/threads/t1/history");
    await authFetch(new Request(`${window.location.origin}/api/info`));
    expect(assign).toHaveBeenCalledOnce();
  });

  it.each([
    ["a relative /api URL", "/api/info"],
    ["a URL object", new URL("/api/info", "http://localhost:3000")],
    ["a Request", new Request("http://localhost:3000/api/info")],
  ])("recognises %s", async (_, input) => {
    respond(401);
    await authFetch(input);
    expect(assign).toHaveBeenCalledOnce();
  });

  it.each([
    ["another origin", "https://graph.example.com/api/threads"],
    ["a direct LangGraph URL", "http://localhost:2024/threads/search"],
    ["a non-API path", "/fonts/report/Inter-400.subset.woff2"],
    ["a lookalike path", "/apiary"],
  ])("leaves a 401 from %s to the caller", async (_, url) => {
    respond(401);
    expect((await authFetch(url)).status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([200, 403, 404, 500])("does not redirect on %i", async (status) => {
    respond(status);
    await authFetch("/api/threads");
    expect(assign).not.toHaveBeenCalled();
  });

  it("copes with mock responses that carry no status", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(authFetch("/api/info")).resolves.toEqual({ ok: true });
    expect(assign).not.toHaveBeenCalled();
  });

  it("propagates network errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(authFetch("/api/info")).rejects.toThrow("Failed to fetch");
  });
});
