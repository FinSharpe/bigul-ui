import { NextResponse, type NextRequest } from "next/server";
import { noStore } from "@/lib/auth/responses";
import { expiredSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

// CSRF guard, as Next does for Server Actions: Origin must match the host.
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = (
    request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  )
    ?.split(",")[0]
    .trim();
  if (!origin || origin === "null" || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request))
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(expiredSessionCookie());
  return noStore(response);
}
