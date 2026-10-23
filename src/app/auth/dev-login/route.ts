import { NextResponse, type NextRequest } from "next/server";
import { normalizeClientCode } from "@/lib/auth/client-code";
import { ConfigError, isDevLoginEnabled } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { loginErrorRedirect, noStore } from "@/lib/auth/responses";
import { mintSession, sessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

/** Local development only: signs in as any client code without Bigul. */
export async function GET(request: NextRequest) {
  if (!isDevLoginEnabled())
    return noStore(new NextResponse(null, { status: 404 }));
  const { searchParams } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const clientCode = normalizeClientCode(searchParams.get("client"));
  if (!clientCode) return loginErrorRedirect(request, "verify", next);

  let session;
  try {
    session = await mintSession(clientCode);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return loginErrorRedirect(request, "config", next);
  }
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(sessionCookie(session.token, session.expiresAt));
  return noStore(response);
}
