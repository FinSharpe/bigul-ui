import { NextResponse, type NextRequest } from "next/server";

export type LoginErrorCode =
  "denied" | "state" | "verify" | "unavailable" | "config";

/** Auth responses carry cookies or identity and must never be cached. */
export function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** 303 back to the login page with an error code and the original destination. */
export function loginErrorRedirect(
  request: NextRequest,
  code: LoginErrorCode,
  next = "/",
): NextResponse {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", code);
  if (next !== "/") url.searchParams.set("next", next);
  return noStore(NextResponse.redirect(url, 303));
}
