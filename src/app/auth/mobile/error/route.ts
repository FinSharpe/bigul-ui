import type { NextRequest } from "next/server";
import { mobileNotice, type MobileErrorCode } from "@/lib/auth/mobile";

export const runtime = "nodejs";

const REOPEN = "Please close Mayra and open it again from the Bigul app.";

const PAGES: Record<
  MobileErrorCode,
  { status: number; title: string; message: string; retryAfterSeconds?: number }
> = {
  missing: { status: 400, title: "Something went wrong", message: REOPEN },
  denied: {
    status: 401,
    title: "Your Bigul session has ended",
    message: REOPEN,
  },
  state: { status: 401, title: "Sign-in didn't finish", message: REOPEN },
  mismatch: { status: 401, title: "Sign-in didn't finish", message: REOPEN },
  verify: {
    status: 401,
    title: "We couldn't confirm your Bigul account",
    message: REOPEN,
  },
  unavailable: {
    status: 503,
    title: "We couldn't reach Bigul",
    message: "Please try again in a few minutes.",
    retryAfterSeconds: 30,
  },
  config: {
    status: 500,
    title: "Mayra isn't available right now",
    message: "Please try again later.",
  },
};

/**
 * Where a failed sign-in in the Bigul app lands. The app intercepts this URL
 * and retries; the page is the fallback when it doesn't. No sign-in link.
 */
export function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const page =
    code && Object.hasOwn(PAGES, code)
      ? PAGES[code as MobileErrorCode]
      : PAGES.missing;
  return mobileNotice(page);
}
