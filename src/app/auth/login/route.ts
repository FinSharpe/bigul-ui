import { NextResponse, type NextRequest } from "next/server";
import { BigulUnavailableError, ssoSessionId } from "@/lib/auth/bigul";
import { ConfigError, getSsoConfig } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { loginErrorRedirect, noStore } from "@/lib/auth/responses";
import { stateCookie } from "@/lib/auth/session";
import { createSsoState, serializeSsoState } from "@/lib/auth/sso-state";

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

  const saved = createSsoState(next);
  const target = new URL(sso.loginUrl);
  target.searchParams.set("app_key", sso.appKey);
  target.searchParams.set("sessionid", sessionId);
  target.searchParams.set("state", saved.state);

  const response = NextResponse.redirect(target, 302);
  response.cookies.set(stateCookie(serializeSsoState(saved)));
  return noStore(response);
}
