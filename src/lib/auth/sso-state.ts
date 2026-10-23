import { randomBytes, timingSafeEqual } from "node:crypto";
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

const CLOCK_SKEW_SECONDS = 60;

export function createSsoState(next: string, now = Date.now()): SsoState {
  return {
    state: randomBytes(32).toString("base64url"),
    sid: randomBytes(16).toString("hex"),
    next: safeNextPath(next),
    iat: Math.floor(now / 1000),
  };
}

export const serializeSsoState = (value: SsoState) => JSON.stringify(value);

/** The saved state if the cookie is well formed and fresh, otherwise null. */
export function parseSsoState(
  raw: string | undefined,
  now = Date.now(),
): SsoState | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { state, sid, next, iat } = value as Record<string, unknown>;
  if (
    typeof state !== "string" ||
    !state ||
    typeof sid !== "string" ||
    typeof next !== "string" ||
    typeof iat !== "number"
  )
    return null;
  const age = Math.floor(now / 1000) - iat;
  if (age > STATE_MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) return null;
  return { state, sid, next: safeNextPath(next), iat };
}

/** Constant-time string comparison. */
export function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
