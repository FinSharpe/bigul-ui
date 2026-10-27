import { NextResponse, type NextRequest } from "next/server";
import {
  BigulUnavailableError,
  BigulVerifyError,
  verifyBigulLogin,
} from "@/lib/auth/bigul";
import {
  ConfigError,
  getMobilePlatforms,
  getSessionConfig,
  getSsoConfig,
} from "@/lib/auth/config";
import {
  ConnectRefusedError,
  ConnectStateError,
  exchangeAppToken,
} from "@/lib/auth/connect-bypass";
import {
  fetchMetadataProblem,
  hasHandoffHeaders,
  hasTokenInQuery,
  mobileErrorRedirect,
  mobileNotice,
  parseHandoff,
  type MobileErrorCode,
  type MobileHandoff,
} from "@/lib/auth/mobile";
import { safeNextPath } from "@/lib/auth/next-path";
import { noStore } from "@/lib/auth/responses";
import {
  embeddedCookie,
  expiredSessionCookie,
  mintSession,
  readSession,
  sessionCookie,
} from "@/lib/auth/session";
import { logTag } from "@/lib/auth/sso-state";

export const runtime = "nodejs";
// The handoff answers within HANDOFF_DEADLINE_MS; the calls it abandons
// (partner login, Connect hops, profile check: 10 s deadlines each) finish
// in the background, well inside this.
export const maxDuration = 60;

// One deadline for the whole sign-in, below the ~15 s after which the app
// gives up on its loading screen. The answer, and with it the expired cookie
// of whoever was signed in before, always reaches the WebView.
const HANDOFF_DEADLINE_MS = 12_000;

/** Connect signed in a different client than the app token names. */
class ClientMismatchError extends Error {
  constructor(readonly returned: string) {
    super("Connect returned another client");
    this.name = "ClientMismatchError";
  }
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.error("[bigul-auth] mobile sign-in took too long", {
        deadlineMs: HANDOFF_DEADLINE_MS,
      });
      reject(new BigulUnavailableError("Mobile sign-in took too long"));
    }, HANDOFF_DEADLINE_MS);
  });
  // An abandoned sign-in must not surface as an unhandled rejection.
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Connect's bypass, our cross-check, the usual verification, a session. */
async function signIn(
  handoff: MobileHandoff,
  callbackUrl: URL,
  userAgent: string | null,
) {
  const { clientCode, accessToken } = await exchangeAppToken({
    platform: handoff.platform,
    token: handoff.token,
    userAgent,
    callbackUrl,
  });
  if (clientCode !== handoff.clientCode)
    throw new ClientMismatchError(logTag(clientCode));
  await verifyBigulLogin({ userid: clientCode, token: accessToken });
  return mintSession(clientCode);
}

function errorCode(error: unknown): MobileErrorCode {
  if (error instanceof ConnectRefusedError) return "denied";
  if (error instanceof ConnectStateError) return "state";
  if (error instanceof BigulVerifyError) return "verify";
  if (error instanceof ConfigError) {
    console.error("[bigul-auth] mobile sign-in is not configured", {
      missing: error.missing,
    });
    return "config";
  }
  if (!(error instanceof BigulUnavailableError))
    console.error("[bigul-auth] unexpected mobile sign-in failure", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  return "unavailable";
}

/**
 * Sign-in for the Bigul app's WebView. The app loads this URL with its own
 * session token in two headers (never the URL); the server exchanges it
 * through Connect's SSO bypass, verifies the result as /auth/callback does,
 * and sends the WebView to the chat. The client never sees a login screen.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));

  // Never read a token from the URL, and change no cookies: a link must not
  // be able to sign anyone in or out.
  if (hasTokenInQuery(searchParams)) {
    console.warn("[bigul-auth] mobile sign-in refused", {
      reason: "token_in_query",
    });
    return mobileNotice({
      status: 400,
      title: "Something went wrong",
      message: "Please close Mayra and open it again from the Bigul app.",
    });
  }
  const blocked = fetchMetadataProblem(request);
  if (blocked) {
    console.warn("[bigul-auth] mobile sign-in refused", { reason: blocked });
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (!hasHandoffHeaders(request.headers)) {
    console.warn("[bigul-auth] mobile sign-in failed", {
      code: "missing",
      reason: "no_headers",
    });
    return mobileErrorRedirect(request, "missing", next);
  }

  // From here the request is the app's handoff. Every answer marks this
  // browser as the app's WebView, and any failure signs out whoever was
  // signed in before: on a shared phone, B must never land in A's chats.
  const existing = await readSession(request);
  // Filled in once the headers are read; identifies attempts without naming the client.
  const tags: { client?: string } = {};
  const fail = (
    code: MobileErrorCode,
    detail: Record<string, unknown> = {},
  ) => {
    console.warn("[bigul-auth] mobile sign-in failed", {
      code,
      client: tags.client,
      hadSession: Boolean(existing),
      ...detail,
    });
    const response = mobileErrorRedirect(request, code, next);
    response.cookies.set(expiredSessionCookie());
    response.cookies.set(embeddedCookie());
    return response;
  };

  let platforms: string[];
  try {
    platforms = getMobilePlatforms();
    // Check our own config before spending the client's token.
    getSessionConfig();
  } catch (error) {
    return fail(errorCode(error), {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
  const handoff = parseHandoff(request.headers, platforms);
  if (!handoff) return fail("missing", { reason: "malformed_headers" });
  tags.client = logTag(handoff.clientCode);

  let session;
  try {
    // Bigul hands the client back to the redirect URL registered with it;
    // by default that is this site's own /auth/callback.
    const callbackUrl = new URL(
      getSsoConfig().redirectUrl ?? new URL("/auth/callback", request.url),
    );
    session = await withDeadline(
      signIn(handoff, callbackUrl, request.headers.get("user-agent")),
    );
  } catch (error) {
    if (error instanceof ClientMismatchError)
      return fail("mismatch", { returned: error.returned });
    return fail(errorCode(error), {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  console.info("[bigul-auth] mobile sign-in ok", {
    client: tags.client,
    switched: existing ? existing.clientCode !== handoff.clientCode : false,
  });
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(sessionCookie(session.token, session.expiresAt));
  response.cookies.set(embeddedCookie());
  return noStore(response);
}

// Next would otherwise run GET for HEAD and spend a sign-in on it.
export function HEAD() {
  return noStore(
    new Response(null, { status: 405, headers: { Allow: "GET" } }),
  );
}
