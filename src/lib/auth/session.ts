import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { normalizeClientCode } from "./client-code";
import { getSessionConfig } from "./config";

// Server-only: signs and verifies the bigul_session JWT (see CONTRACT.md).

export const STATE_MAX_AGE_SECONDS = 600;

const secure = () => process.env.NODE_ENV === "production";

// In production __Host- stops a sibling subdomain from planting either cookie
// (a planted state cookie allows login CSRF). __Host- needs Path=/, so the
// state cookie is site-wide too; /api strips cookies before LangGraph.
export const sessionCookieName = () =>
  secure() ? "__Host-bigul_session" : "bigul_session";
export const stateCookieName = () =>
  secure() ? "__Host-bigul_sso_state" : "bigul_sso_state";
// Set by /auth/mobile: this browser is the Bigul app's WebView, where the
// client must never be shown a sign-in screen.
export const embeddedCookieName = () =>
  secure() ? "__Host-bigul_embedded" : "bigul_embedded";

// Outlives the 00:30 IST session, so an expired session still knows it is
// in the app; renewed on every handoff.
export const EMBEDDED_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// 00:30 IST, when Bigul's own client tokens expire.
const EXPIRY_HOUR_UTC = 19;
const MIN_SESSION_MS = 5 * 60 * 1000;

export type Session = { clientCode: string; expiresAt: Date };
export type SessionWithToken = Session & { token: string };

const toMs = (now: Date | number) =>
  typeof now === "number" ? now : now.getTime();

/** The next 19:00 UTC after `now`, or the one after if that is under 5 minutes away. */
export function nextSessionExpiry(now: Date | number = Date.now()): Date {
  const nowMs = toMs(now);
  const expiry = new Date(nowMs);
  expiry.setUTCHours(EXPIRY_HOUR_UTC, 0, 0, 0);
  if (expiry.getTime() <= nowMs) expiry.setUTCDate(expiry.getUTCDate() + 1);
  if (expiry.getTime() - nowMs < MIN_SESSION_MS)
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry;
}

/** Signs a session for a Bigul client code. Throws ConfigError without a key. */
export async function mintSession(
  clientCode: string,
  now: Date | number = Date.now(),
): Promise<{ token: string; expiresAt: Date }> {
  const sub = normalizeClientCode(clientCode);
  if (!sub) throw new Error("Invalid client code");
  const { privateKey, kid, issuer, audience } = getSessionConfig();
  const nowMs = toMs(now);
  const expiresAt = nextSessionExpiry(nowMs);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setJti(randomBytes(16).toString("base64url"))
    .sign(privateKey);
  return { token, expiresAt };
}

/** The session in a token, or null for anything invalid, expired or unverifiable. */
export async function verifySessionToken(
  token: string | null | undefined,
  now?: Date,
): Promise<Session | null> {
  if (!token) return null;
  try {
    const { publicKey, issuer, audience } = getSessionConfig();
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      issuer,
      audience,
      requiredClaims: ["sub", "iat", "exp", "jti"],
      currentDate: now,
    });
    const clientCode = normalizeClientCode(payload.sub);
    if (!clientCode || clientCode !== payload.sub || !payload.exp) return null;
    return { clientCode, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}

async function withToken(
  token: string | undefined,
): Promise<SessionWithToken | null> {
  const session = await verifySessionToken(token);
  return session && token ? { ...session, token } : null;
}

/** Session from a request's cookie (proxy and route handlers). */
export function readSession(
  request: NextRequest,
): Promise<SessionWithToken | null> {
  return withToken(request.cookies.get(sessionCookieName())?.value);
}

/** Session for Server Components. */
export async function getServerSession(): Promise<SessionWithToken | null> {
  const store = await cookies();
  return withToken(store.get(sessionCookieName())?.value);
}

// __Host- needs Secure, Path=/ and no Domain; the expired cookie too.
export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: sessionCookieName(),
    value: token,
    httpOnly: true,
    secure: secure(),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export function expiredSessionCookie() {
  return { ...sessionCookie("", new Date(0)), maxAge: 0 };
}

export function stateCookie(value: string) {
  return {
    name: stateCookieName(),
    value,
    httpOnly: true,
    secure: secure(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS,
  };
}

// Same attributes as the live cookie, as __Host- requires.
export function expiredStateCookie() {
  return { ...stateCookie(""), maxAge: 0, expires: new Date(0) };
}

export function embeddedCookie() {
  return {
    name: embeddedCookieName(),
    value: "1",
    httpOnly: true,
    secure: secure(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: EMBEDDED_MAX_AGE_SECONDS,
  };
}

/** The request comes from the Bigul app's WebView (route handlers). */
export function hasEmbeddedMarker(request: NextRequest): boolean {
  return request.cookies.get(embeddedCookieName())?.value === "1";
}

/** The page is shown in the Bigul app's WebView (Server Components). */
export async function isEmbedded(): Promise<boolean> {
  const store = await cookies();
  return store.get(embeddedCookieName())?.value === "1";
}
