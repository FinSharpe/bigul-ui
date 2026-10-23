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
import { mintSession } from "@/lib/auth/session";
import { BLANK_AUTH_ENV, testPrivateKeyPem } from "@/lib/auth/test-keys";
import { DELETE, GET, OPTIONS, POST, maxDuration } from "./route";

const UPSTREAM = "https://graph.example.langgraph.app";
let pem: string;
let jwt: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  pem = testPrivateKeyPem();
});

beforeEach(async () => {
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
  vi.stubEnv("LANGGRAPH_API_URL", UPSTREAM);
  jwt = (await mintSession("Y09042341")).token;
  fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOSTILE_HEADERS = {
  authorization: "Bearer someone-elses-token",
  "x-api-key": "client-supplied-key",
  "x-auth-scheme": "langsmith",
  "x-tenant-id": "tenant",
  "x-user-id": "user",
};

function apiRequest(
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return new NextRequest(`http://localhost:3000/api${path}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    ...(init.body !== undefined && { body: init.body }),
  });
}

const upstream = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(url),
    init: init as RequestInit & { headers: Record<string, string> },
  };
};

describe("/api LangGraph proxy", () => {
  it.each([
    ["no cookie", {}],
    ["an invalid session", { cookie: "bigul_session=forged" }],
    [
      "only a client bearer token",
      { authorization: `Bearer ${"x".repeat(20)}` },
    ],
  ])("refuses %s with 401 and never calls LangGraph", async (_, headers) => {
    const response = await GET(apiRequest("/threads/t1", { headers }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the session as a bearer token and strips client credentials", async () => {
    const body = JSON.stringify({ metadata: { graph_id: "agent" }, limit: 2 });
    const response = await POST(
      apiRequest("/threads/search", {
        method: "POST",
        body,
        headers: {
          ...HOSTILE_HEADERS,
          cookie: `bigul_session=${jwt}; other=1`,
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(200);
    const { url, init } = upstream();
    expect(url).toBe(`${UPSTREAM}/threads/search`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(init.headers.authorization).toBe(`Bearer ${jwt}`);
    expect(init.headers.Authorization).toBeUndefined();
    for (const name of ["x-auth-scheme", "x-tenant-id", "x-user-id", "cookie"])
      expect(init.headers).not.toHaveProperty(name);
    expect(init.headers["x-api-key"]).not.toBe("client-supplied-key");
    expect(init.headers["x-api-key"]).not.toBe("remove-me");
  });

  it("injects the server LangSmith key only when one is configured", async () => {
    const cookie = `bigul_session=${jwt}`;
    vi.stubEnv("LANGSMITH_API_KEY", "lsv2_server_key");
    await GET(apiRequest("/info", { headers: { ...HOSTILE_HEADERS, cookie } }));
    expect(upstream().init.headers["x-api-key"]).toBe("lsv2_server_key");

    vi.stubEnv("LANGSMITH_API_KEY", "");
    await GET(apiRequest("/info", { headers: { ...HOSTILE_HEADERS, cookie } }));
    // The passthrough always sets the header; without a key it is empty.
    expect(upstream().init.headers["x-api-key"]).toBe("");
  });

  it("keeps the path and query string", async () => {
    await GET(
      apiRequest("/threads/t1/history?limit=3", {
        headers: { cookie: `bigul_session=${jwt}` },
      }),
    );
    expect(upstream().url).toBe(`${UPSTREAM}/threads/t1/history?limit=3`);
    await DELETE(
      apiRequest("/threads/t1", {
        method: "DELETE",
        headers: { cookie: `bigul_session=${jwt}` },
      }),
    );
    expect(upstream().init.method).toBe("DELETE");
  });

  it("drops encoding headers that no longer describe the decoded body", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"models":[]}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "999",
        },
      }),
    );
    const response = await GET(
      apiRequest("/api/models", {
        headers: { cookie: `bigul_session=${jwt}` },
      }),
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"models":[]}');
  });

  it("passes upstream errors through", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: "Thread not found" }, { status: 404 }),
    );
    const response = await GET(
      apiRequest("/threads/missing", {
        headers: { cookie: `bigul_session=${jwt}` },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("turns LangGraph rejecting a valid session into a 502, so the browser does not loop through /login", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await GET(
      apiRequest("/threads/t1", {
        headers: { cookie: `bigul_session=${jwt}` },
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_auth" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cancelled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("BIGUL_SESSION_PUBLIC_KEY"),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(jwt);
  });

  it("forwards a well-formed Last-Event-ID so a stream can resume", async () => {
    const cookie = `bigul_session=${jwt}`;
    await GET(
      apiRequest("/threads/t1/runs/r1/stream", {
        headers: { cookie, "Last-Event-ID": "1729512345678-0" },
      }),
    );
    expect(upstream().init.headers["last-event-id"]).toBe("1729512345678-0");

    await GET(
      apiRequest("/threads/t1/runs/r1/stream", { headers: { cookie } }),
    );
    expect(upstream().init.headers).not.toHaveProperty("last-event-id");
  });

  it.each([
    ["too long", "1".repeat(129)],
    ["with a space", "1 2"],
    ["non-ASCII", "é"],
  ])("drops a Last-Event-ID that is %s", async (_, value) => {
    await GET(
      apiRequest("/threads/t1/runs/r1/stream", {
        headers: { cookie: `bigul_session=${jwt}`, "last-event-id": value },
      }),
    );
    expect(upstream().init.headers).not.toHaveProperty("last-event-id");
  });

  it("allows agent streams five minutes", () => {
    expect(maxDuration).toBe(300);
  });

  it("answers 503 when no LangGraph URL is configured", async () => {
    vi.stubEnv("LANGGRAPH_API_URL", "");
    const response = await GET(
      apiRequest("/info", { headers: { cookie: `bigul_session=${jwt}` } }),
    );
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers CORS preflight without a session", () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
