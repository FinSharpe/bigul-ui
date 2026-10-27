import { NextResponse, type NextRequest } from "next/server";
import { normalizeClientCode } from "./client-code";
import { noStore } from "./responses";

// Server-only. Sign-in for the Bigul app's WebView: the app sends its own
// session token in headers on the first load, and /auth/mobile exchanges it
// through Bigul Connect's SSO bypass. Never log the token.

export const PLATFORM_HEADER = "x-bigul-platform";
export const TOKEN_HEADER = "x-bigul-token";

/** Why a mobile sign-in failed; each has a page at /auth/mobile/error. */
export type MobileErrorCode =
  | "missing"
  | "denied"
  | "state"
  | "mismatch"
  | "verify"
  | "unavailable"
  | "config";

// A JWT (three base64url parts); base64's "+/=" tolerated. Never "%", ","
// or spaces: a pre-encoded value would be encoded twice, and Headers.get
// joins repeated headers with ", ".
const TOKEN_PATTERN = /^[\w+/=-]+\.[\w+/=-]+\.[\w+/=-]+$/;
const TOKEN_MIN = 16;
const TOKEN_MAX = 4096;
const PLATFORM_PATTERN = /^\d{1,3}$/;
// Never accepted in the URL: a token there lands in request logs, and a
// link carrying someone else's token would sign the victim in as them.
const TOKEN_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "sessionid",
  "platform",
  "client_code",
]);

export type MobileHandoff = {
  platform: string;
  token: string;
  /** The client the app token names. Decoded only, never trusted alone. */
  clientCode: string;
};

/** Whether the request carries either handoff header. */
export function hasHandoffHeaders(headers: Headers): boolean {
  return headers.has(PLATFORM_HEADER) || headers.has(TOKEN_HEADER);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The client code inside the Bigul app's session JWT (`LoginId`, else
 * `unique_name`), or null. Its signature is Bigul's and is not checked here:
 * Connect and the profile check prove the client, this only cross-checks.
 */
export function appTokenClientCode(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(
        payload.replace(/\+/g, "-").replace(/\//g, "_"),
        "base64url",
      ).toString("utf8"),
    );
    if (!isRecord(claims)) return null;
    return (
      normalizeClientCode(claims.LoginId) ??
      normalizeClientCode(claims.unique_name)
    );
  } catch {
    return null;
  }
}

/** Both headers, well formed and allowed, or null. */
export function parseHandoff(
  headers: Headers,
  allowedPlatforms: readonly string[],
): MobileHandoff | null {
  const platform = headers.get(PLATFORM_HEADER)?.trim();
  const token = headers.get(TOKEN_HEADER)?.trim();
  if (!platform || !token) return null;
  if (!PLATFORM_PATTERN.test(platform) || !allowedPlatforms.includes(platform))
    return null;
  if (
    token.length < TOKEN_MIN ||
    token.length > TOKEN_MAX ||
    !TOKEN_PATTERN.test(token)
  )
    return null;
  const clientCode = appTokenClientCode(token);
  return clientCode ? { platform, token, clientCode } : null;
}

/** True when the URL carries a token-like parameter (never read). */
export function hasTokenInQuery(params: URLSearchParams): boolean {
  for (const key of params.keys())
    if (TOKEN_QUERY_KEYS.has(key.toLowerCase())) return true;
  return false;
}

function requestHost(request: NextRequest): string | undefined {
  return (
    request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  )
    ?.split(",")[0]
    .trim();
}

/**
 * Why the request cannot be the app's own top-level load, or null. A
 * cross-site page cannot add the handoff headers without a CORS preflight,
 * which this route never answers; these checks are a backstop. Headers are
 * only checked when present: older WebViews send no fetch metadata.
 */
export function fetchMetadataProblem(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      return "origin";
    }
    if (origin === "null" || host !== requestHost(request)) return "origin";
  }
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null && mode !== "navigate") return "mode";
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "none" && site !== "same-origin") return "site";
  return null;
}

/** 303 to the mobile error page; the app intercepts it by URL. */
export function mobileErrorRedirect(
  request: NextRequest,
  code: MobileErrorCode,
  next = "/",
): NextResponse {
  const url = new URL("/auth/mobile/error", request.url);
  url.searchParams.set("code", code);
  if (next !== "/") url.searchParams.set("next", next);
  return noStore(NextResponse.redirect(url, 303));
}

const NOTICE_STYLE =
  "body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;color:#18202a;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:360px;margin:16px;padding:28px 24px;background:#fff;border-radius:12px;box-shadow:0 1px 4px #0002;text-align:center}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5b6573}";

/**
 * A small self-contained page for the WebView. Text is fixed per status,
 * never taken from the request, and there is deliberately no sign-in link:
 * inside the app the client must never see a login screen.
 */
export function mobileNotice(options: {
  status: number;
  title: string;
  message: string;
  retryAfterSeconds?: number;
}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${options.title} · Mayra AI</title><style>${NOTICE_STYLE}</style></head><body><main><h1>${options.title}</h1><p>${options.message}</p></main></body></html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
  });
  if (options.retryAfterSeconds !== undefined)
    headers.set("Retry-After", String(options.retryAfterSeconds));
  return noStore(new Response(html, { status: options.status, headers }));
}
