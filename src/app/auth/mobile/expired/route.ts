import { mobileNotice } from "@/lib/auth/mobile";

export const runtime = "nodejs";

/**
 * Where a signed-out request lands inside the Bigul app (sessions end at
 * 00:30 IST). The app intercepts this URL and signs the client in again with
 * a fresh token; the page is the fallback when it doesn't. No sign-in link.
 */
export function GET() {
  return mobileNotice({
    status: 401,
    title: "Your session has ended",
    message: "Please close Mayra and open it again from the Bigul app.",
  });
}
