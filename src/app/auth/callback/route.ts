import { NextResponse, type NextRequest } from "next/server";
import {
  BigulUnavailableError,
  BigulVerifyError,
  verifyBigulLogin,
} from "@/lib/auth/bigul";
import { normalizeClientCode } from "@/lib/auth/client-code";
import { ConfigError, getSessionConfig } from "@/lib/auth/config";
import { parseRawQuery, rawQueryString } from "@/lib/auth/query";
import {
  loginErrorRedirect,
  noStore,
  type LoginErrorCode,
} from "@/lib/auth/responses";
import {
  expiredStateCookie,
  mintSession,
  sessionCookie,
  stateCookieName,
} from "@/lib/auth/session";
import { parseSsoState, sameState } from "@/lib/auth/sso-state";

export const runtime = "nodejs";
// Worst case is four sequential Bigul calls (login, profile, re-login,
// profile) of at most 10 s each, relay failover included: 40 s. Fail with our
// own error page, not a platform 504.
export const maxDuration = 60;

function errorCode(error: unknown): LoginErrorCode {
  if (error instanceof BigulVerifyError) return "verify";
  if (error instanceof ConfigError) {
    console.error("[bigul-auth] sign-in is not configured", {
      missing: error.missing,
    });
    return "config";
  }
  if (!(error instanceof BigulUnavailableError))
    console.error("[bigul-auth] unexpected callback failure", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  return "unavailable";
}

/**
 * Bigul's SSO redirect target. The token is checked with Bigul server-side,
 * then discarded; only our own session JWT is kept.
 */
export async function GET(request: NextRequest) {
  // Raw parsing: Bigul tokens contain "+", which URLSearchParams turns into " ".
  const query = parseRawQuery(rawQueryString(request.url));
  const saved = parseSsoState(request.cookies.get(stateCookieName())?.value);
  const next = saved?.next ?? "/";
  const fail = (code: LoginErrorCode) => {
    const response = loginErrorRedirect(request, code, next);
    response.cookies.set(expiredStateCookie());
    return response;
  };

  // Production Bigul (23 Oct 2026) redirects with status=success,
  // access_token and client_code; its docs show login_success=true, token and
  // userid. Accept either shape.
  const succeeded =
    query.get("status") === "success" || query.get("login_success") === "true";
  if (!succeeded) return fail("denied");
  const state = query.get("state");
  if (!state || !saved || !sameState(state, saved.state)) return fail("state");
  // Next re-serialises the query before handlers see it, writing spaces as
  // "+". Client codes never contain "+", so read it as a space here only.
  const userid = (query.get("client_code") ?? query.get("userid"))?.replace(
    /\+/g,
    " ",
  );
  const token = query.get("access_token") ?? query.get("token");
  if (!userid || !token) return fail("denied");
  const clientCode = normalizeClientCode(userid);
  if (!clientCode) return fail("verify");

  let session;
  try {
    // Check our own config before spending the client's token.
    getSessionConfig();
    await verifyBigulLogin({ userid: clientCode, token });
    session = await mintSession(clientCode);
  } catch (error) {
    return fail(errorCode(error));
  }

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(sessionCookie(session.token, session.expiresAt));
  response.cookies.set(expiredStateCookie());
  return noStore(response);
}
