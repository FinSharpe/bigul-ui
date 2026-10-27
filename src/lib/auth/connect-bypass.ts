import { randomBytes } from "node:crypto";
import { BigulUnavailableError, ssoSessionId } from "./bigul";
import { normalizeClientCode } from "./client-code";
import { getSsoConfig } from "./config";
import { parseRawQuery, rawQueryString } from "./query";
import { sameState } from "./sso-state";

// Server-only. Bigul Connect's re-login-free SSO: the usual SSO login link
// plus `platform` and the client's app session `token` signs the client in
// without a login screen. Connect passes the request through a few of its own
// pages (302s carrying its cookies), then redirects to our registered
// callback with status, access_token and client_code. A refused token ends on
// Connect's normal login page instead. This module runs that chain from the
// server, so the WebView never shows a Connect page. Never log the tokens or
// the URLs.

/** Connect did not sign the client in (its login page, or a failure status). */
export class ConnectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectRefusedError";
  }
}

/** Connect answered with a state other than the one we sent. */
export class ConnectStateError extends Error {
  constructor() {
    super("Connect returned a different state");
    this.name = "ConnectStateError";
  }
}

// One deadline for the whole chain.
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; MayraAI/1.0)";

function log(message: string, detail: Record<string, unknown> = {}) {
  console.error(`[bigul-auth] ${message}`, detail);
}

const isRedirect = (status: number) =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308;

function storeCookies(jar: Map<string, string>, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0];
    const split = pair.indexOf("=");
    if (split <= 0) continue;
    const name = pair.slice(0, split).trim();
    const value = pair.slice(split + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

export type BypassResult = { clientCode: string; accessToken: string };

/**
 * Reads Connect's hand-back redirect; throws when it is not a sign-in. The
 * query is read from the raw Location header: Bigul tokens contain "+".
 */
function readHandBack(
  location: URL,
  rawLocation: string,
  state: string,
  callbackUrl: URL,
): BypassResult {
  // Only our registered callback (same scheme, host and port), or the site
  // root on that origin in Bigul's documented shape.
  const ours =
    location.origin === callbackUrl.origin &&
    (location.pathname === callbackUrl.pathname || location.pathname === "/");
  if (!ours) {
    log("connect bypass ended off the callback", {
      sameOrigin: location.origin === callbackUrl.origin,
    });
    throw new ConnectRefusedError("Unexpected redirect");
  }
  const query = parseRawQuery(rawQueryString(rawLocation));
  const succeeded =
    query.get("status") === "success" || query.get("login_success") === "true";
  if (!succeeded) throw new ConnectRefusedError("Connect refused the token");
  const returned = query.get("state");
  if (!returned || !sameState(returned, state)) throw new ConnectStateError();
  // Client codes never contain "+"; Bigul pads them with a space.
  const clientCode = normalizeClientCode(
    (query.get("client_code") ?? query.get("userid"))?.replace(/\+/g, " "),
  );
  const accessToken = query.get("access_token") ?? query.get("token");
  if (!clientCode || !accessToken)
    throw new ConnectRefusedError("Incomplete hand-back");
  return { clientCode, accessToken };
}

/**
 * Exchanges the Bigul app's session token for a Connect client token issued
 * to our app. Follows redirects only on Connect's own origin, carrying only
 * the cookies Connect sets, and never requests the hand-back URL, which
 * must be `callbackUrl` (the redirect URL registered with Bigul). Throws
 * ConnectRefusedError, ConnectStateError, BigulUnavailableError or
 * ConfigError. The returned token still needs verifyBigulLogin.
 */
export async function exchangeAppToken({
  platform,
  token,
  userAgent,
  callbackUrl,
}: {
  platform: string;
  token: string;
  userAgent?: string | null;
  callbackUrl: URL;
}): Promise<BypassResult> {
  const sso = getSsoConfig();
  // Connect's login refuses anything but our live partner session here.
  const sessionId = await ssoSessionId();
  const state = randomBytes(32).toString("base64url");
  const start = new URL(sso.loginUrl);
  start.searchParams.set("app_key", sso.appKey);
  start.searchParams.set("sessionid", sessionId);
  start.searchParams.set("state", state);
  start.searchParams.set("platform", platform);
  start.searchParams.set("token", token);

  const connectOrigin = start.origin;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const jar = new Map<string, string>();
  let url = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "User-Agent": userAgent?.trim() || DEFAULT_USER_AGENT,
      };
      if (jar.size) headers.Cookie = cookieHeader(jar);
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      log("connect bypass request failed", {
        hop,
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw new BigulUnavailableError("Connect bypass request failed");
    }
    await response.body?.cancel().catch(() => {});
    storeCookies(jar, response);

    const location = response.headers.get("location");
    if (isRedirect(response.status) && location) {
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new ConnectRefusedError("Unreadable redirect");
      }
      if (next.origin !== connectOrigin)
        return readHandBack(next, location, state, callbackUrl);
      url = next;
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      log("connect bypass unavailable", { hop, status: response.status });
      throw new BigulUnavailableError("Connect bypass unavailable");
    }
    // A page instead of a redirect: Connect's login form when it refuses the
    // token. Treated as a refusal; the client is never shown it.
    log("connect bypass refused", { hop, status: response.status });
    throw new ConnectRefusedError("Connect answered with a page");
  }
  log("connect bypass redirected too often", { hops: MAX_REDIRECTS });
  throw new BigulUnavailableError("Too many Connect redirects");
}
