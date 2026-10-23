import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { safeNextPath } from "./next-path";
import { STATE_MAX_AGE_SECONDS } from "./session";

// The bigul_sso_state cookie: {"state","sid","next"} plus "iat" (seconds), so
// freshness is checked on the server as well as by the cookie's Max-Age.

export type SsoState = {
  state: string;
  sid: string;
  next: string;
  iat: number;
};

/** Why a state cookie was not usable. */
export type SsoStateProblem = "no_cookie" | "malformed" | "expired";

const CLOCK_SKEW_SECONDS = 60;

// A second tap on "Sign in" within this window reuses the pending state, so
// whichever Bigul tab the client finishes in still matches the cookie. It is
// half the cookie's life, leaving at least five minutes to finish at Bigul.
export const STATE_REUSE_SECONDS = 300;

const nowSeconds = (now: number) => Math.floor(now / 1000);

export function createSsoState(next: string, now = Date.now()): SsoState {
  return {
    state: randomBytes(32).toString("base64url"),
    sid: randomBytes(16).toString("hex"),
    next: safeNextPath(next),
    iat: nowSeconds(now),
  };
}

/**
 * The state to send to Bigul: the pending one if it is recent (keeping its
 * state, sid and iat, with the new destination), otherwise a new one.
 */
export function reuseOrCreateSsoState(
  pending: SsoState | null,
  next: string,
  now = Date.now(),
): SsoState {
  if (pending && nowSeconds(now) - pending.iat <= STATE_REUSE_SECONDS)
    return { ...pending, next: safeNextPath(next) };
  return createSsoState(next, now);
}

export const serializeSsoState = (value: SsoState) => JSON.stringify(value);

/** The saved state, or why there is none, for the cookie's raw value. */
export function readSsoState(
  raw: string | undefined,
  now = Date.now(),
):
  | { saved: SsoState; problem?: undefined }
  | { saved: null; problem: SsoStateProblem } {
  if (!raw) return { saved: null, problem: "no_cookie" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { saved: null, problem: "malformed" };
  }
  if (typeof value !== "object" || value === null)
    return { saved: null, problem: "malformed" };
  const { state, sid, next, iat } = value as Record<string, unknown>;
  if (
    typeof state !== "string" ||
    !state ||
    typeof sid !== "string" ||
    typeof next !== "string" ||
    typeof iat !== "number"
  )
    return { saved: null, problem: "malformed" };
  const age = stateAgeSeconds(iat, now);
  if (age > STATE_MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS)
    return { saved: null, problem: "expired" };
  return { saved: { state, sid, next: safeNextPath(next), iat } };
}

/** The saved state if the cookie is well formed and fresh, otherwise null. */
export function parseSsoState(
  raw: string | undefined,
  now = Date.now(),
): SsoState | null {
  return readSsoState(raw, now).saved;
}

export const stateAgeSeconds = (iat: number, now = Date.now()) =>
  nowSeconds(now) - iat;

/** Constant-time string comparison. */
export function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A short sha256 tag for logs, so values can be compared without printing
 * them. Safe for random states; a client code's tag can be guessed by brute
 * force, so treat logs holding one as holding client codes.
 */
export const logTag = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 10);
