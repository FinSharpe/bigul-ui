// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BigulUnavailableError,
  BigulVerifyError,
  resetPartnerSessionCache,
  ssoSessionId,
  verifyBigulLogin,
} from "./bigul";
import { closeRelayAgents, RELAY_CONNECT_TIMEOUT_MS } from "./bigul-relay";
import { BLANK_AUTH_ENV } from "./test-keys";

// Real sockets: a local Bigul stand-in, and local CONNECT proxies in front of
// it. The proxies tunnel every CONNECT to the stand-in whatever host it
// names, so the app uses Bigul-like host names that only the relay resolves.

const SECRETS = {
  BIGUL_API_KEY: "api-key-k1",
  BIGUL_API_SECRET: "api-secret-s2",
  BIGUL_PARTNER_CODE: "PARTNER01",
  BIGUL_PARTNER_PASSWORD: "partner-password-p3",
};
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// Shaped like Bigul's access_token: an HS256 JWT naming the client and our app.
const TOKEN = [
  b64({ alg: "HS256", typ: "JWT" }),
  b64({
    tokenData: { app_key: "api-key-k1", client_code: "Y09042341" },
    exp: 4_102_444_800,
  }),
  "c2ln",
].join(".");
const API = "/api/v1";
const SESSION_PATH = `${API}/partner/auth/session-login`;
const PROFILE_PATH = `${API}/auth/connect/get-client-profile`;
const RELAY_USER = "relay-user";
const RELAY_PASSWORD = "p@ss:w/rd";
const RELAY_AUTH = `Basic ${Buffer.from(`${RELAY_USER}:${RELAY_PASSWORD}`).toString("base64")}`;
const relayUrl = (port: number, password = RELAY_PASSWORD) =>
  `http://${RELAY_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}`;

// Windows takes about 2 s to report a refused loopback connection.
const SLOW = 30_000;

const closers: (() => void)[] = [];

function track(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return sockets;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

type TargetRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
};
type Reply = { status: number; body: unknown; delayMs?: number };

/** Bigul's partner API, plain HTTP. */
async function startBigul(
  replies: { session?: () => Reply; profile?: () => Reply } = {},
) {
  const requests: TargetRequest[] = [];
  let sessions = 0;
  const server = createHttpServer(async (req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers });
    req.resume();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let reply: Reply;
    if (path === SESSION_PATH) {
      sessions += 1;
      reply = replies.session?.() ?? {
        status: 200,
        body: {
          status: true,
          data: {
            sessionId: `partner-session-${sessions}`,
            expiryTime: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      };
    } else if (path === PROFILE_PATH) {
      reply = replies.profile?.() ?? {
        status: 200,
        body: { status: true, data: [{ clientcode: "Y09042341" }] },
      };
    } else reply = { status: 404, body: {} };
    if (reply.delayMs)
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  track(server);
  return { port: await listen(server), requests };
}

/** A TLS endpoint stand-in that hangs up as soon as the handshake starts. */
async function startHangUp() {
  const server = createTcpServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.destroy());
  });
  track(server);
  return { port: await listen(server) };
}

type ProxyMode = "tunnel" | "silent" | { status: number };

/** An authenticated CONNECT proxy, like the relays' Squid. */
async function startRelay(targetPort: number, mode: ProxyMode = "tunnel") {
  const tunnels: { authority: string; proxyAuthorization?: string }[] = [];
  const tunnelled: Buffer[] = [];
  let plainRequests = 0;
  const server = createHttpServer((_req, res) => {
    plainRequests += 1;
    res.writeHead(405).end();
  });
  const sockets = track(server);
  server.on("connect", (req, client: Socket, head: Buffer) => {
    client.on("error", () => {});
    tunnels.push({
      authority: req.url ?? "",
      proxyAuthorization: req.headers["proxy-authorization"],
    });
    if (mode === "silent") return;
    if (req.headers["proxy-authorization"] !== RELAY_AUTH) {
      client.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="relay"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    if (typeof mode === "object") {
      client.end(`HTTP/1.1 ${mode.status} Denied\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = connectTcp(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.on("data", (chunk: Buffer) => tunnelled.push(chunk));
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
  });
  const port = await listen(server);
  return {
    port,
    url: relayUrl(port),
    tunnels,
    tunnelled,
    plainRequests: () => plainRequests,
  };
}

/** A relay address where nothing listens. */
async function deadRelayUrl(): Promise<string> {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return relayUrl(port);
}

const useRelays = (...urls: string[]) =>
  vi.stubEnv("BIGUL_OUTBOUND_PROXY_URLS", urls.join(" , "));
const verify = () => verifyBigulLogin({ userid: "Y09042341", token: TOKEN });
const logged = () => vi.mocked(console.error).mock.calls;

let globalFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetPartnerSessionCache();
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_API_BASE_URL", `http://papi.bigul.test${API}`);
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  globalFetch = vi.fn();
  vi.stubGlobal("fetch", globalFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await closeRelayAgents();
  for (const close of closers.splice(0)) close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Bigul calls through relays", () => {
  it("tunnels each call through the first relay with Proxy-Authorization", async () => {
    const bigul = await startBigul();
    const relay = await startRelay(bigul.port);
    useRelays(relay.url);

    await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });

    // One CONNECT for the one call, naming Bigul's host; the relay resolves it.
    expect(relay.tunnels).toEqual([
      { authority: "papi.bigul.test:80", proxyAuthorization: RELAY_AUTH },
    ]);
    expect(relay.plainRequests()).toBe(0);
    expect(bigul.requests.map((request) => request.path)).toEqual([
      `${PROFILE_PATH}?clientCode=Y09042341&source=B2B`,
    ]);
    for (const { headers } of bigul.requests) {
      expect(headers.host).toBe("papi.bigul.test");
      expect(headers["x-api-secret"]).toBe(SECRETS.BIGUL_API_SECRET);
      expect(headers["proxy-authorization"]).toBeUndefined();
    }
    expect(bigul.requests[0].headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(bigul.requests[0].headers["x-vendor-auth"]).toBeUndefined();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("sends the partner login for the SSO link through the relay too", async () => {
    const bigul = await startBigul();
    const relay = await startRelay(bigul.port);
    useRelays(relay.url);

    await expect(ssoSessionId()).resolves.toBe("partner-session-1");

    expect(relay.tunnels).toEqual([
      { authority: "papi.bigul.test:80", proxyAuthorization: RELAY_AUTH },
    ]);
    expect(bigul.requests.map((request) => request.path)).toEqual([
      SESSION_PATH,
    ]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it(
    "fails over to the secondary when the primary refuses connections",
    async () => {
      const bigul = await startBigul();
      const secondary = await startRelay(bigul.port);
      useRelays(await deadRelayUrl(), secondary.url);

      await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });

      expect(secondary.tunnels).toHaveLength(1);
      expect(bigul.requests).toHaveLength(1);
      expect(logged()).toEqual([
        [
          "[bigul-auth] client profile relay unreachable",
          { relay: 1, reason: "Error", code: "ECONNREFUSED" },
        ],
      ]);
    },
    SLOW,
  );

  it.each([
    ["rejects its credentials", 407, "wrong-password", "tunnel" as const],
    ["refuses the tunnel", 403, RELAY_PASSWORD, { status: 403 }],
  ])("fails over when the primary %s", async (_, status, password, mode) => {
    const bigul = await startBigul();
    const primary = await startRelay(bigul.port, mode);
    const secondary = await startRelay(bigul.port);
    useRelays(relayUrl(primary.port, password), secondary.url);

    await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });

    expect(primary.tunnels).toHaveLength(1);
    expect(secondary.tunnels).toHaveLength(1);
    expect(bigul.requests).toHaveLength(1);
    expect(logged()).toEqual([
      ["[bigul-auth] client profile relay unreachable", { relay: 1, status }],
    ]);
  });

  it(
    "fails over within the relay timeout when the primary never answers CONNECT",
    async () => {
      const bigul = await startBigul();
      const primary = await startRelay(bigul.port, "silent");
      const secondary = await startRelay(bigul.port);
      useRelays(primary.url, secondary.url);

      const started = Date.now();
      await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });
      const elapsed = Date.now() - started;

      expect(primary.tunnels).toHaveLength(1);
      expect(secondary.tunnels).toHaveLength(1);
      expect(elapsed).toBeGreaterThanOrEqual(RELAY_CONNECT_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(RELAY_CONNECT_TIMEOUT_MS + 2_000);
      expect(logged()).toEqual([
        [
          "[bigul-auth] client profile relay unreachable",
          { relay: 1, reason: "TimeoutError" },
        ],
      ]);
    },
    SLOW,
  );

  it(
    "reports Bigul unavailable when no relay can be reached",
    async () => {
      useRelays(await deadRelayUrl(), await deadRelayUrl());

      await expect(verify()).rejects.toBeInstanceOf(BigulUnavailableError);

      expect(logged()).toEqual([
        [
          "[bigul-auth] client profile relay unreachable",
          { relay: 1, reason: "Error", code: "ECONNREFUSED" },
        ],
        [
          "[bigul-auth] client profile relay unreachable",
          { relay: 2, reason: "Error", code: "ECONNREFUSED" },
        ],
        ["[bigul-auth] client profile request failed", { reason: "TypeError" }],
      ]);
    },
    SLOW,
  );

  it.each([
    ["a 503", 503, BigulUnavailableError],
    ["a 401", 401, BigulVerifyError],
  ])(
    "does not fail over when Bigul answers with %s",
    async (_, status, error) => {
      const bigul = await startBigul({
        profile: () => ({ status, body: { status: false, message: "No" } }),
      });
      const primary = await startRelay(bigul.port);
      const secondary = await startRelay(bigul.port);
      useRelays(primary.url, secondary.url);

      await expect(verify()).rejects.toBeInstanceOf(error);

      expect(primary.tunnels).toHaveLength(1);
      expect(secondary.tunnels).toHaveLength(0);
      expect(bigul.requests).toHaveLength(1);
    },
  );

  it(
    "does not fail over when Bigul is slower than the relay timeout",
    async () => {
      const bigul = await startBigul({
        profile: () => ({
          status: 200,
          delayMs: RELAY_CONNECT_TIMEOUT_MS + 500,
          body: { status: true, data: [{ clientcode: "Y09042341" }] },
        }),
      });
      const primary = await startRelay(bigul.port);
      const secondary = await startRelay(bigul.port);
      useRelays(primary.url, secondary.url);

      await expect(verify()).resolves.toEqual({ clientCode: "Y09042341" });

      expect(primary.tunnels).toHaveLength(1);
      expect(secondary.tunnels).toHaveLength(0);
      expect(console.error).not.toHaveBeenCalled();
    },
    SLOW,
  );

  it("keeps TLS end to end: the relay only carries the encrypted stream", async () => {
    vi.stubEnv("BIGUL_API_BASE_URL", `https://papi.bigul.test${API}`);
    const bigul = await startHangUp();
    const primary = await startRelay(bigul.port);
    const secondary = await startRelay(bigul.port);
    useRelays(primary.url, secondary.url);

    // The stand-in hangs up mid-handshake: a failure past the relay, so no
    // failover.
    await expect(verify()).rejects.toBeInstanceOf(BigulUnavailableError);

    expect(primary.tunnels).toEqual([
      { authority: "papi.bigul.test:443", proxyAuthorization: RELAY_AUTH },
    ]);
    expect(secondary.tunnels).toHaveLength(0);
    const carried = Buffer.concat(primary.tunnelled);
    // A TLS ClientHello for Bigul's host (SNI), not an HTTP request.
    expect(carried[0]).toBe(0x16);
    expect(carried.includes("papi.bigul.test")).toBe(true);
    for (const plain of [
      "get-client-profile",
      TOKEN,
      SECRETS.BIGUL_API_KEY,
      SECRETS.BIGUL_API_SECRET,
      SECRETS.BIGUL_PARTNER_PASSWORD,
    ])
      expect(carried.includes(plain)).toBe(false);
    expect(logged()).toEqual([
      ["[bigul-auth] client profile request failed", { reason: "TypeError" }],
    ]);
  });

  it(
    "never logs a relay's address or credentials",
    async () => {
      const bigul = await startBigul();
      const refusing = await startRelay(bigul.port, { status: 403 });
      const dead = await deadRelayUrl();
      useRelays(dead, refusing.url);

      await expect(verify()).rejects.toBeInstanceOf(BigulUnavailableError);

      const text = JSON.stringify(logged());
      expect(text).toContain("relay unreachable");
      for (const secret of [
        "127.0.0.1",
        String(refusing.port),
        new URL(dead).port,
        RELAY_USER,
        RELAY_PASSWORD,
        encodeURIComponent(RELAY_PASSWORD),
        RELAY_AUTH,
      ])
        expect(text).not.toContain(secret);
    },
    SLOW,
  );
});
