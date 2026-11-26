import { NextResponse, type NextRequest } from "next/server";
import { normalizeClientCode } from "@/lib/auth/client-code";
import { ConfigError, isDevLoginEnabled } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { loginErrorRedirect, noStore } from "@/lib/auth/responses";
import { appCookie, mintSession, sessionCookie } from "@/lib/auth/session";
import { themeFor } from "@/lib/platform";

const PLATFORM_PATTERN = /^\d{1,3}$/;

export const runtime = "nodejs";

/**
 * Local development only: signs in as any client code without Bigul.
 * `?platform=NNN` signs in as that app's WebView would (plt claim, app cookie).
 */
export async function GET(request: NextRequest) {
  if (!isDevLoginEnabled())
    return noStore(new NextResponse(null, { status: 404 }));
  const { searchParams } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const clientCode = normalizeClientCode(searchParams.get("client"));
  if (!clientCode) return loginErrorRedirect(request, "verify", next);
  const platform = searchParams.get("platform") ?? undefined;
  if (platform !== undefined && !PLATFORM_PATTERN.test(platform))
    return loginErrorRedirect(request, "verify", next);

  let session;
  try {
    session = await mintSession(clientCode, { platform });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return loginErrorRedirect(request, "config", next);
  }
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(sessionCookie(session.token, session.expiresAt));
  if (platform) response.cookies.set(appCookie(themeFor(platform)));
  return noStore(response);
}
