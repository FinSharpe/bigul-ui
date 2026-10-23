/**
 * Local stand-in for Bigul Connect, for end-to-end testing of the bigul-ui SSO
 * login. Shapes follow what production Bigul did on 23 Oct 2026 (where it differs
 * from Bigul's public docs); every credential here is a fake test value. Never
 * point a deployment at it.
 *
 * node tests/support/mock-bigul-connect.mjs
 *
 * bigul-ui env for `next dev` against the defaults:
 *   BIGUL_SSO_LOGIN_URL=http://127.0.0.1:3300/login
 *   BIGUL_SSO_APP_KEY=mock-api-key   (Bigul's SSO app_key is the app's API key)
 *   BIGUL_API_BASE_URL=http://127.0.0.1:3300/api/v1
 *   BIGUL_API_KEY=mock-api-key  BIGUL_API_SECRET=mock-api-secret
 *   BIGUL_PARTNER_CODE=PARTNER01  BIGUL_PARTNER_PASSWORD=mock-partner-password
 * Open the UI on the same host as MOCK_BIGUL_REDIRECT_URL (localhost, not
 * 127.0.0.1), or the state cookie is missing and login ends in ?error=state.
 *
 * Env (defaults in brackets):
 *   MOCK_BIGUL_PORT [3300; 0 = any free port], MOCK_BIGUL_APP_KEY [the API key],
 *   MOCK_BIGUL_API_KEY [mock-api-key], MOCK_BIGUL_API_SECRET [mock-api-secret],
 *   MOCK_BIGUL_PARTNER_CODE [PARTNER01],
 *   MOCK_BIGUL_PARTNER_PASSWORD [mock-partner-password],
 *   MOCK_BIGUL_REDIRECT_URL [http://localhost:3000/auth/callback],
 *   MOCK_BIGUL_API_PREFIX [/api/v1] path the partner API is served under, as
 *                                   in Bigul's {{baseUrl}}; "" serves it at the
 *                                   root. The SSO page (/login, on Bigul's
 *                                   connect host) and the test controls below
 *                                   are always at the root.
 *   MOCK_BIGUL_REDIRECT_MODE=root   redirect to the site root
 *   MOCK_BIGUL_FAIL=a,b             profile-5xx | session-5xx | profile-mismatch |
 *                                   slow (15 s delay on API calls); separate
 *                                   with "," or "|" (quote "|" in a shell)
 *   MOCK_BIGUL_SESSION_TTL_SECONDS  partner session lifetime [until next 19:00 UTC]
 *
 * As on production: the login page refuses a sessionid that is not a live
 * partner session; the redirect is status=success&state&access_token&client_code;
 * access_token is an HS256 JWT (mock key) naming the client and the app key;
 * get-client-profile is a GET with the API key/secret and the Bearer token, no
 * partner session, and answers 401 "client_code mismatch" for another client.
 * Test controls: GET /__state (counts only), POST /__scenario { fail },
 * POST /__expire-sessions (drops partner sessions; the next login link fails
 * until the app logs in again).
 */
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";

const env = process.env;
const port = Number(env.MOCK_BIGUL_PORT || 3300);
const apiKey = env.MOCK_BIGUL_API_KEY || "mock-api-key";
const appKey = env.MOCK_BIGUL_APP_KEY || apiKey;
const apiSecret = env.MOCK_BIGUL_API_SECRET || "mock-api-secret";
const partnerCode = env.MOCK_BIGUL_PARTNER_CODE || "PARTNER01";
const partnerPassword =
  env.MOCK_BIGUL_PARTNER_PASSWORD || "mock-partner-password";
const redirectUrl =
  env.MOCK_BIGUL_REDIRECT_URL || "http://localhost:3000/auth/callback";
const redirectToRoot = env.MOCK_BIGUL_REDIRECT_MODE === "root";
const sessionTtlSeconds = Number(env.MOCK_BIGUL_SESSION_TTL_SECONDS) || 0;
const apiPrefix = parsePrefix(env.MOCK_BIGUL_API_PREFIX ?? "/api/v1");
const SOURCE = "B2B";
const SLOW_MS = 15000;
const FAIL_MODES = ["profile-5xx", "session-5xx", "profile-mismatch", "slow"];
const ACCESS_DENIED =
  "Access denied: API key/secret invalid, or the requesting IP address is not authorized.";

const callbackBase = redirectToRoot
  ? `${new URL(redirectUrl).origin}/`
  : redirectUrl;
let fail = parseFail(env.MOCK_BIGUL_FAIL);
const partnerSessions = new Map(); // sessionId -> expiry (ms)
// Signs mock access tokens; Bigul's real key is unknown to partners.
const tokenKey = randomBytes(32);
let tokensIssued = 0;

function parsePrefix(value) {
  const prefix = String(value).trim().replace(/\/+$/, "");
  if (prefix && !/^(\/[\w.~-]+)+$/.test(prefix))
    throw new Error(
      `MOCK_BIGUL_API_PREFIX must be a path such as /api/v1, or empty`,
    );
  return prefix;
}

function parseFail(value) {
  const modes = (
    Array.isArray(value) ? value : String(value ?? "").split(/[,|]/)
  )
    .map((mode) => String(mode).trim())
    .filter(Boolean);
  const unknown = modes.filter((mode) => !FAIL_MODES.includes(mode));
  if (unknown.length)
    throw new Error(
      `Unknown fail mode ${unknown.join(", ")}; use ${FAIL_MODES.join(", ")}`,
    );
  return new Set(modes);
}

// Bigul client tokens and partner sessions both lapse at 00:30 IST.
function nextExpiry(now = Date.now()) {
  const expiry = new Date(now);
  expiry.setUTCHours(19, 0, 0, 0);
  if (expiry.getTime() <= now) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.getTime();
}

const b64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (data) =>
  createHmac("sha256", tokenKey).update(data).digest("base64url");

// Shaped like production's access_token (fields trimmed to fakes).
function issueToken(clientCode) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    tokenData: {
      app_key: appKey,
      client_name: `MOCK CLIENT ${clientCode}`,
      client_code: clientCode,
      source: `${SOURCE}_${partnerCode}`,
      type: "CLIENT",
    },
    iat: now,
    exp: Math.floor(nextExpiry() / 1000),
  })}`;
  tokensIssued += 1;
  return `${data}.${sign(data)}`;
}

// The client code a live token was issued for, or null.
function tokenClient(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || sign(`${parts[0]}.${parts[1]}`) !== parts[2])
    return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload.tokenData.client_code;
  } catch {
    return null;
  }
}

function liveSession(sessionId) {
  const expiry = sessionId && partnerSessions.get(sessionId);
  if (expiry && expiry > Date.now()) return true;
  if (expiry) partnerSessions.delete(sessionId);
  return false;
}

const failure = (message, error = "") => ({
  status: false,
  message,
  data: null,
  error,
});

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

// Gateway-style outage page: callers must not assume a JSON body on 5xx.
function sendOutage(response, ctx) {
  ctx.outcome = "simulated 5xx";
  sendHtml(
    response,
    503,
    "<!doctype html><title>503</title><h1>503 Service Unavailable</h1>",
  );
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:15px system-ui;margin:0;padding:40px 16px;background:#f4f6f8;color:#18242c}main{max-width:360px;margin:auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px #0002}h1{font-size:20px;margin:0 0 6px}p{color:#5e6872;margin:0 0 18px}label{display:block;font-weight:600;margin-bottom:6px}input{box-sizing:border-box;width:100%;padding:9px;font:inherit;border:1px solid #c5ced6;border-radius:6px}.actions{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:10px;font:inherit;border-radius:6px;border:1px solid #3265a8;cursor:pointer}button[value=approve]{background:#3265a8;color:#fff}button[value=deny]{background:#fff;color:#3265a8}.error{color:#b42318}</style></head><body><main>${body}</main></body></html>`;
}

function loginForm({ sessionid, state, clientCode = "TEST01", error = "" }) {
  return page(
    "Mock Bigul login",
    `<h1>Mock Bigul login</h1><p>Local test fixture. No real Bigul account is used.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/login"><input type="hidden" name="app_key" value="${escapeHtml(appKey)}"><input type="hidden" name="sessionid" value="${escapeHtml(sessionid)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><label for="client_code">Client code</label><input id="client_code" name="client_code" value="${escapeHtml(clientCode)}" autocomplete="off" autofocus><div class="actions"><button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny">Deny</button></div></form>`,
  );
}

function loginProblem(params) {
  if (!params.get("app_key")) return "missing app_key";
  if (params.get("app_key") !== appKey) return "unknown app_key";
  if (!liveSession(params.get("sessionid")))
    return "Vendor session is invalid or expired.";
  if (!params.get("state")) return "missing state";
  return "";
}

function badLogin(response, ctx, problem) {
  ctx.outcome = `rejected: ${problem}`;
  sendHtml(
    response,
    400,
    page(
      "Mock Bigul login: bad request",
      `<h1>Bad request</h1><p class="error">${escapeHtml(problem)}</p>`,
    ),
  );
}

// Built by hand, in production's parameter order.
function redirectToCallback(response, query) {
  const separator = callbackBase.includes("?") ? "&" : "?";
  response.writeHead(302, {
    Location: `${callbackBase}${separator}${query}`,
    "Cache-Control": "no-store",
  });
  response.end();
}

function hasApiCredentials(request) {
  return (
    request.headers["x-api-key"] === apiKey &&
    request.headers["x-api-secret"] === apiSecret
  );
}

async function maybeSlow(ctx) {
  if (!fail.has("slow")) return;
  ctx.slow = true;
  await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
}

// The caller may have timed out during a slow delay.
const gone = (response) => response.destroyed || response.socket?.destroyed;

function parseJson(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Bigul Connect's SSO page, at the root.
const pageRoutes = {
  "GET /login"({ url, response, ctx }) {
    const problem = loginProblem(url.searchParams);
    if (problem) return badLogin(response, ctx, problem);
    ctx.outcome = "login page";
    sendHtml(
      response,
      200,
      loginForm({
        sessionid: url.searchParams.get("sessionid"),
        state: url.searchParams.get("state"),
      }),
    );
  },

  "POST /login"({ body, response, ctx }) {
    const form = new URLSearchParams(body);
    const problem = loginProblem(form);
    if (problem) return badLogin(response, ctx, problem);
    const state = form.get("state");
    const action = form.get("action");
    if (action === "deny") {
      ctx.outcome = `denied -> ${new URL(callbackBase).pathname}`;
      return redirectToCallback(
        response,
        `status=failed&state=${encodeURIComponent(state)}`,
      );
    }
    if (action !== "approve") return badLogin(response, ctx, "unknown action");
    const typed = form.get("client_code") ?? "";
    const clientCode = typed.trim().toUpperCase();
    if (!clientCode) {
      ctx.outcome = "rejected: empty client code";
      return sendHtml(
        response,
        400,
        loginForm({
          sessionid: form.get("sessionid"),
          state,
          clientCode: "",
          error: "Enter a client code.",
        }),
      );
    }
    const token = issueToken(clientCode);
    ctx.outcome = `approved ${clientCode} -> ${new URL(callbackBase).pathname}`;
    redirectToCallback(
      response,
      `status=success&state=${encodeURIComponent(state)}&access_token=${token}&client_code=${encodeURIComponent(clientCode)}`,
    );
  },
};

// Partner API, served under apiPrefix.
const apiRoutes = {
  async "POST /partner/auth/session-login"({ request, body, response, ctx }) {
    await maybeSlow(ctx);
    if (gone(response)) return;
    if (fail.has("session-5xx")) return sendOutage(response, ctx);
    if (!hasApiCredentials(request)) {
      ctx.outcome = "access denied";
      return sendJson(response, 403, failure(ACCESS_DENIED));
    }
    const payload = parseJson(body);
    if (
      payload?.source !== SOURCE ||
      payload.code !== partnerCode ||
      payload.password !== partnerPassword
    ) {
      ctx.outcome = "invalid credentials";
      return sendJson(response, 200, failure("Invalid credentials"));
    }
    const sessionId = randomBytes(16).toString("hex");
    const expiry = sessionTtlSeconds
      ? Date.now() + sessionTtlSeconds * 1000
      : nextExpiry();
    partnerSessions.set(sessionId, expiry);
    ctx.outcome = "session created";
    sendJson(response, 200, {
      status: true,
      message: "Session created successfully.",
      data: { sessionId, expiryTime: new Date(expiry).toISOString() },
      error: null,
    });
  },

  async "POST /partner/auth/session-logout"({ request, response, ctx }) {
    await maybeSlow(ctx);
    if (gone(response)) return;
    if (fail.has("session-5xx")) return sendOutage(response, ctx);
    if (!hasApiCredentials(request)) {
      ctx.outcome = "access denied";
      return sendJson(response, 403, failure(ACCESS_DENIED));
    }
    const sessionId = request.headers["x-access-token"];
    if (!liveSession(sessionId)) {
      ctx.outcome = "unknown session";
      return sendJson(response, 401, failure("Invalid vendor session"));
    }
    partnerSessions.delete(sessionId);
    ctx.outcome = "session ended";
    sendJson(response, 200, {
      status: true,
      message: "Session logged out successfully.",
      data: null,
      error: null,
    });
  },

  async "GET /auth/connect/get-client-profile"({
    request,
    url,
    response,
    ctx,
  }) {
    await maybeSlow(ctx);
    if (gone(response)) return;
    if (fail.has("profile-5xx")) return sendOutage(response, ctx);
    if (!hasApiCredentials(request)) {
      ctx.outcome = "access denied";
      return sendJson(response, 403, failure(ACCESS_DENIED));
    }
    if (url.searchParams.get("source") !== SOURCE) {
      ctx.outcome = "invalid source";
      return sendJson(response, 400, failure("Invalid source"));
    }
    const requested = (url.searchParams.get("clientCode") ?? "")
      .trim()
      .toUpperCase();
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    if (!bearer) {
      ctx.outcome = "missing token";
      return sendJson(response, 401, {
        message: "Access token is missing or invalid",
      });
    }
    const owner = tokenClient(bearer[1]);
    if (!owner) {
      ctx.outcome = "invalid token";
      return sendJson(response, 401, { message: "Invalid or expired token" });
    }
    if (owner !== requested) {
      ctx.outcome = `client_code mismatch for ${requested || "(none)"}`;
      return sendJson(response, 401, {
        message: "Token authenticate error (client_code mismatch)",
      });
    }
    // Production pads the code with a space.
    const code = fail.has("profile-mismatch") ? `${owner}X` : `${owner} `;
    ctx.outcome = `verified ${owner}${fail.has("profile-mismatch") ? ` (answered ${code})` : ""}`;
    sendJson(response, 200, {
      status: true,
      message: "Profile info fetched successfully.",
      data: [
        {
          image: "",
          clientcode: code,
          poa: "true",
          name: `MOCK CLIENT ${code}`,
          dpid: "1203350000000000",
          dpName: `MOCK CLIENT ${code}`,
          activesegments: "NSE|BSE|NFO|",
          brokerid: "BIGUL",
          products: "INTRADAY,DELIVERY",
        },
      ],
      error: null,
    });
  },
};

// Test controls, at the root.
const controlRoutes = {
  "GET /__state"({ response, ctx }) {
    ctx.outcome = "state";
    sendJson(response, 200, {
      fail: [...fail],
      redirect: redirectToRoot ? "root" : "path",
      partnerSessions: [...partnerSessions.keys()].filter(liveSession).length,
      tokens: tokensIssued,
    });
  },

  "POST /__scenario"({ body, response, ctx }) {
    try {
      fail = parseFail(parseJson(body)?.fail ?? "");
    } catch (error) {
      ctx.outcome = "bad scenario";
      return sendJson(response, 400, { error: error.message });
    }
    ctx.outcome = `fail=${[...fail].join(",") || "none"}`;
    sendJson(response, 200, { fail: [...fail] });
  },

  "POST /__expire-sessions"({ response, ctx }) {
    const expired = partnerSessions.size;
    partnerSessions.clear();
    ctx.outcome = `expired ${expired} partner session(s)`;
    sendJson(response, 200, { expired });
  },
};

// Unprefixed API paths 404, as they would on Bigul.
function findRoute(method, pathname) {
  const key = `${method} ${pathname}`;
  const root = pageRoutes[key] ?? controlRoutes[key];
  if (root || !pathname.startsWith(`${apiPrefix}/`)) return root;
  return apiRoutes[`${method} ${pathname.slice(apiPrefix.length)}`];
}

const MAX_BODY = 64 * 1024;

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY) return null;
  }
  return body;
}

// Path only: the query and headers carry state, tokens and credentials.
function log(request, pathname, response, ctx) {
  const status = response.writableFinished ? response.statusCode : "aborted";
  const slow = ctx.slow ? " (slow)" : "";
  process.stdout.write(
    `${new Date().toISOString()} ${request.method} ${pathname} ${status} ${ctx.outcome}${slow}\n`,
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock.invalid");
  const ctx = { outcome: "", slow: false };
  response.on("close", () => log(request, url.pathname, response, ctx));
  const route = findRoute(request.method, url.pathname);
  if (!route) {
    ctx.outcome = "no route";
    return sendJson(response, 404, failure("Not found"));
  }
  try {
    const body = await readBody(request);
    if (body === null) {
      ctx.outcome = "body too large";
      return sendJson(response, 413, failure("Payload too large"));
    }
    await route({ request, response, url, body, ctx });
  } catch (error) {
    ctx.outcome = `internal error (${error?.name ?? "unknown"})`;
    if (!response.headersSent && !gone(response))
      sendJson(response, 500, failure("Internal server error"));
  }
});

function shutdown(signal) {
  process.stdout.write(`${signal}: stopping mock Bigul Connect\n`);
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  const modes = fail.size ? `, fail: ${[...fail].join(",")}` : "";
  process.stdout.write(
    `Mock Bigul Connect: http://127.0.0.1:${bound} (API base http://127.0.0.1:${bound}${apiPrefix}, redirects to ${callbackBase}${modes})\n`,
  );
});
