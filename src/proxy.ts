import { NextResponse, type NextRequest } from "next/server";
import { rawQueryString } from "@/lib/auth/query";
import { noStore } from "@/lib/auth/responses";
import { readSession } from "@/lib/auth/session";

// Optimistic gate: verifies the session cookie locally, no network calls.
// /api and the page re-check the session themselves.

const isUnder = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export async function proxy(request: NextRequest) {
  if (request.method === "OPTIONS") return NextResponse.next();
  const { pathname, search, searchParams } = request.nextUrl;

  // Bigul's docs send the SSO redirect to the site root. Forward the query as
  // received (no URLSearchParams round trip of our own); the callback's
  // decode-only parsing reads the token whether or not Next re-serialised it.
  if (
    pathname === "/" &&
    (searchParams.has("login_success") || searchParams.has("status")) &&
    searchParams.has("state")
  ) {
    const callback = new URL(
      `/auth/callback?${rawQueryString(request.url)}`,
      request.url,
    );
    return noStore(NextResponse.redirect(callback, 307));
  }

  if (isUnder(pathname, "/auth") || isUnder(pathname, "/login"))
    return NextResponse.next();
  if (await readSession(request)) return NextResponse.next();

  if (isUnder(pathname, "/api"))
    return noStore(
      NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    );
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return noStore(NextResponse.redirect(login, 307));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/webpack-hmr|favicon\\.ico|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|css|js|map|txt|xml|webmanifest)$).*)",
  ],
};
