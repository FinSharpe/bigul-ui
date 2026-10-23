import { NextResponse, type NextRequest } from "next/server";
import { BigulUnavailableError, ssoSessionId } from "@/lib/auth/bigul";
import { ConfigError, getSsoConfig } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { loginErrorRedirect, noStore } from "@/lib/auth/responses";
import { stateCookie, stateCookieName } from "@/lib/auth/session";
import {
  logTag,
  parseSsoState,
  reuseOrCreateSsoState,
  serializeSsoState,
} from "@/lib/auth/sso-state";

export const runtime = "nodejs";

/** Starts Bigul SSO: remembers state in a short-lived cookie, then sends the browser to Bigul. */
export async function GET(request: NextRequest) {
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  let sso;
  let sessionId;
  try {
    sso = getSsoConfig();
    // Bigul's login page requires our live partner session as `sessionid`.
    sessionId = await ssoSessionId();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error("[bigul-auth] SSO is not configured", {
        missing: error.missing,
      });
      return loginErrorRedirect(request, "config", next);
    }
    if (error instanceof BigulUnavailableError)
      return loginErrorRedirect(request, "unavailable", next);
    throw error;
  }

  // A double tap must not replace the state the first tap sent to Bigul.
  const pending = parseSsoState(request.cookies.get(stateCookieName())?.value);
  const saved = reuseOrCreateSsoState(pending, next);
  console.info("[bigul-auth] sign-in started", {
    state: logTag(saved.state),
    reused: saved.state === pending?.state,
  });
  const target = new URL(sso.loginUrl);
  target.searchParams.set("app_key", sso.appKey);
  target.searchParams.set("sessionid", sessionId);
  target.searchParams.set("state", saved.state);

  const response = NextResponse.redirect(target, 302);
  response.cookies.set(stateCookie(serializeSsoState(saved)));
  return noStore(response);
}
