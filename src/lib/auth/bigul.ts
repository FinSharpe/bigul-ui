import { fetchThroughRelays } from "./bigul-relay";
import { normalizeClientCode } from "./client-code";
import { getBigulApiConfig, type BigulApiConfig } from "./config";

// Server-only. Confirms a Bigul SSO login with Bigul's partner APIs.
// Never log the client token, partner password, API secret or partner sessionId.

/** Bigul answered, and the answer is not a verified login for this client. */
export class BigulVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigulVerifyError";
  }
}

/**
 * Bigul could not be asked or gave no usable answer: network, timeout, an
 * unreadable body, 403, 4xx other than 401, 5xx or a failed partner login.
 */
export class BigulUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigulUnavailableError";
  }
}

// One 10 s deadline per Bigul call. It covers the request, reading the body
// and, through relays, every relay tried: a relay is only skipped while its
// tunnel is opening (at most RELAY_CONNECT_TIMEOUT_MS, 3 s), so behind a dead
// primary the secondary still has at least 7 s. A callback makes one call
// (the client check), well inside its 60 s maxDuration.
const TIMEOUT_MS = 10_000;
const SESSION_MARGIN_MS = 5 * 60 * 1000;
const MESSAGE_MAX_LENGTH = 200;
// Bigul tokens are base64-like; anything else (spaces, controls) is malformed.
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

type PartnerSession = { sessionId: string; reusableUntil: number; key: string };
type Answer = { status: number; body: unknown };

let cachedSession: PartnerSession | null = null;
let pendingSession: { key: string; promise: Promise<PartnerSession> } | null =
  null;

/** Clears the in-memory partner session (tests). */
export function resetPartnerSessionCache() {
  cachedSession = null;
  pendingSession = null;
}

function log(message: string, detail: Record<string, unknown> = {}) {
  console.error(`[bigul-auth] ${message}`, detail);
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * The status plus Bigul's `message`, safe to log: strings only, control
 * characters stripped, any known secret masked, at most 200 characters.
 */
function logDetail(answer: Answer, secrets: string[]) {
  const raw = isRecord(answer.body) ? answer.body.message : undefined;
  if (typeof raw !== "string") return { status: answer.status };
  let message = raw.replace(/\p{Cc}/gu, "");
  for (const secret of secrets)
    if (secret) message = message.split(secret).join("[redacted]");
  return {
    status: answer.status,
    message: message.slice(0, MESSAGE_MAX_LENGTH),
  };
}

const configSecrets = (config: BigulApiConfig) => [
  config.apiKey,
  config.apiSecret,
  config.partnerPassword,
];

type BigulRequest = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

/**
 * One Bigul call, direct or through the configured relays. The timeout also
 * covers reading the body.
 */
async function callBigul(
  config: BigulApiConfig,
  name: string,
  url: string,
  init: BigulRequest,
): Promise<Answer> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const relays = config.outboundProxyUrls;
  try {
    const response = relays.length
      ? await fetchThroughRelays(
          relays,
          url,
          { ...init, signal },
          (relay, failure) =>
            log(`${name} relay unreachable`, { relay, ...failure }),
        )
      : await fetch(url, { ...init, signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: callers decide what that means for this status.
    }
    return { status: response.status, body };
  } catch (error) {
    log(`${name} request failed`, { reason: failureReason(error) });
    throw new BigulUnavailableError(`${name} request failed`);
  }
}

const configKey = (config: BigulApiConfig) =>
  [config.baseUrl, config.source, config.apiKey, config.partnerCode].join("\n");

async function loginPartner(
  config: BigulApiConfig,
  key: string,
): Promise<PartnerSession> {
  const answer = await callBigul(
    config,
    "partner session",
    `${config.baseUrl}/partner/auth/session-login`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "x-api-secret": config.apiSecret,
      },
      body: JSON.stringify({
        source: config.source,
        code: config.partnerCode,
        password: config.partnerPassword,
      }),
    },
  );
  const { body } = answer;
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const sessionId = data?.sessionId;
  if (
    !isSuccess(answer.status) ||
    !isRecord(body) ||
    body.status !== true ||
    typeof sessionId !== "string" ||
    !sessionId
  ) {
    const secrets = configSecrets(config);
    if (typeof sessionId === "string") secrets.push(sessionId);
    log("partner session login rejected", logDetail(answer, secrets));
    throw new BigulUnavailableError("Partner session login rejected");
  }
  const expiry =
    typeof data?.expiryTime === "string" ? Date.parse(data.expiryTime) : NaN;
  // Without a usable expiry the session is used once and not cached.
  const reusableUntil = Number.isFinite(expiry)
    ? expiry - SESSION_MARGIN_MS
    : 0;
  return { sessionId, reusableUntil, key };
}

function startLogin(
  config: BigulApiConfig,
  key: string,
): Promise<PartnerSession> {
  const promise: Promise<PartnerSession> = loginPartner(config, key).then(
    (session) => {
      if (pendingSession?.promise === promise) pendingSession = null;
      if (session.reusableUntil > Date.now()) cachedSession = session;
      return session;
    },
    (error: unknown) => {
      if (pendingSession?.promise === promise) pendingSession = null;
      throw error;
    },
  );
  pendingSession = { key, promise };
  return promise;
}

const usableCache = (key: string) =>
  cachedSession?.key === key && cachedSession.reusableUntil > Date.now()
    ? cachedSession
    : null;

/** Cached partner session; concurrent callers share one login request. */
async function partnerSession(config: BigulApiConfig): Promise<PartnerSession> {
  const key = configKey(config);
  const cached = usableCache(key);
  if (cached) return cached;
  return pendingSession?.key === key
    ? pendingSession.promise
    : startLogin(config, key);
}

/**
 * The partner sessionId for the SSO login URL: Bigul's login page refuses a
 * `sessionid` that is not a live vendor session ("Vendor session is invalid
 * or expired"). Bigul returns the same session to repeat logins, so every
 * server instance sends the same value. Never log it.
 */
export async function ssoSessionId(): Promise<string> {
  return (await partnerSession(getBigulApiConfig())).sessionId;
}

/**
 * Bigul's client profile, as Bigul confirmed on 23 Oct 2026: a GET with the
 * app key/secret and the client's token, no partner session. Verified on
 * production that it answers 401 "client_code mismatch" for another client's
 * code, and 401 for a fake, missing or non-Bearer token.
 */
function fetchProfile(
  config: BigulApiConfig,
  clientCode: string,
  token: string,
): Promise<Answer> {
  const url = new URL(`${config.baseUrl}/auth/connect/get-client-profile`);
  url.searchParams.set("clientCode", clientCode);
  url.searchParams.set("source", config.source);
  return callBigul(config, "client profile", url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": config.apiKey,
      "x-api-secret": config.apiSecret,
      Authorization: `Bearer ${token}`,
    },
  });
}

function unavailableReason(status: number): string {
  if (status === 403) return "forbidden: API key/secret or IP not authorized";
  if (status === 429) return "rate limited";
  if (status === 400) return "bad request";
  if (status >= 500) return "server error";
  return "unexpected status";
}

/** Returns when `answer` verifies `clientCode`; throws otherwise. */
function checkProfile(answer: Answer, clientCode: string, secrets: string[]) {
  const { status, body } = answer;
  const notVerified = (reason: string) => {
    log("client login not verified", { ...logDetail(answer, secrets), reason });
    return new BigulVerifyError("Client login not verified");
  };
  const unavailable = (reason: string) => {
    log("client profile unavailable", {
      ...logDetail(answer, secrets),
      reason,
    });
    return new BigulUnavailableError("Client profile unavailable");
  };

  if (status === 401) throw notVerified("unauthorized");
  if (!isSuccess(status)) throw unavailable(unavailableReason(status));
  if (!isRecord(body) || typeof body.status !== "boolean")
    throw unavailable("unexpected response");
  if (!body.status) throw notVerified("refused");
  const profile = Array.isArray(body.data) ? body.data[0] : undefined;
  if (
    !isRecord(profile) ||
    normalizeClientCode(profile.clientcode) !== clientCode
  )
    throw notVerified("profile mismatch");
}

/** The claims we use from Bigul's access_token JWT (HS256, Bigul's key). */
function tokenClaims(
  token: string,
): { clientCode: string | null; appKey: unknown; exp: unknown } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (!isRecord(payload) || !isRecord(payload.tokenData)) return null;
    return {
      clientCode: normalizeClientCode(payload.tokenData.client_code),
      appKey: payload.tokenData.app_key,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

// A margin calculation for one share: nothing is placed. Bigul's docs sample.
const MARGIN_PROBE = {
  brnchId: "NA",
  exSeg: "nse_cm",
  prc: "12500",
  prcTp: "L",
  prod: "CNC",
  qty: "1",
  tok: "11536",
  trnsTp: "B",
};

/**
 * Cheap local checks before asking Bigul. We cannot verify the token's
 * signature (Bigul's key), so Bigul's answer is what proves it; these only
 * reject an obviously wrong token without a network call: the client code we
 * sign in must be the one inside the token, and the token must be for our app
 * and unexpired.
 */
function checkTokenClaims(
  config: BigulApiConfig,
  clientCode: string,
  token: string,
) {
  const notVerified = (reason: string) => {
    log("client login not verified", { reason });
    return new BigulVerifyError("Client login not verified");
  };
  const claims = tokenClaims(token);
  if (!claims) throw notVerified("token is not a Bigul JWT");
  if (claims.clientCode !== clientCode)
    throw notVerified("token is for another client");
  if (claims.appKey !== config.apiKey)
    throw notVerified("token is for another app");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now())
    throw notVerified("token expired");
}

/**
 * Fallback check (BIGUL_VERIFY_WITH=margin): Bigul accepts the token for this
 * client on the margin-calculation API. Nothing is placed.
 */
async function verifyWithMargin(
  config: BigulApiConfig,
  clientCode: string,
  token: string,
) {
  const secrets = [token, ...configSecrets(config)];
  const notVerified = (reason: string, answer: Answer) => {
    log("client login not verified", { ...logDetail(answer, secrets), reason });
    return new BigulVerifyError("Client login not verified");
  };

  const answer = await callBigul(
    config,
    "client margin check",
    `${config.baseUrl}/order/user-margin`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "x-api-secret": config.apiSecret,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: config.source,
        clientCode,
        ...MARGIN_PROBE,
      }),
    },
  );
  const { status, body } = answer;
  if (status === 401) throw notVerified("unauthorized", answer);
  if (!isSuccess(status)) {
    log("client margin check unavailable", {
      ...logDetail(answer, secrets),
      reason: unavailableReason(status),
    });
    throw new BigulUnavailableError("Client margin check unavailable");
  }
  if (!isRecord(body) || body.status !== true)
    throw notVerified("refused", answer);
}

/** "profile" (default) or "margin" (fallback). */
const verifyMethod = () =>
  process.env.BIGUL_VERIFY_WITH?.trim() === "margin" ? "margin" : "profile";

/**
 * Confirms with Bigul that `token` is a live login for client `userid`.
 * Resolves with the normalised client code; throws BigulVerifyError,
 * BigulUnavailableError or ConfigError.
 */
export async function verifyBigulLogin({
  userid,
  token,
}: {
  userid: string;
  token: string;
}): Promise<{ clientCode: string }> {
  const clientCode = normalizeClientCode(userid);
  if (!clientCode || !TOKEN_PATTERN.test(token))
    throw new BigulVerifyError("Malformed login response");
  const config = getBigulApiConfig();
  checkTokenClaims(config, clientCode, token);
  if (verifyMethod() === "margin") {
    await verifyWithMargin(config, clientCode, token);
    return { clientCode };
  }
  const answer = await fetchProfile(config, clientCode, token);
  checkProfile(answer, clientCode, [token, ...configSecrets(config)]);
  return { clientCode };
}
