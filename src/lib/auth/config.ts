import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";

// Server-only. Env is read at call time so builds need no secrets and tests
// can stub values.

export class ConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[], detail?: string) {
    super(detail ?? `Missing auth configuration: ${missing.join(", ")}`);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv<const K extends string>(names: K[]): Record<K, string> {
  const values = {} as Record<K, string>;
  const missing: string[] = [];
  for (const name of names) {
    const value = env(name);
    if (value) values[name] = value;
    else missing.push(name);
  }
  if (missing.length) throw new ConfigError(missing);
  return values;
}

function parseUrl(name: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:")
      return value.replace(/\/+$/, "");
  } catch {
    // Reported below without echoing the value.
  }
  throw new ConfigError([name], `${name} is not a valid http(s) URL`);
}

export type SessionConfig = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  issuer: string;
  audience: string;
};

type SessionKeys = Pick<SessionConfig, "privateKey" | "publicKey" | "kid">;
let keyCache: { source: string; keys: SessionKeys } | null = null;

function privateKeyPem(): string {
  const inline = env("BIGUL_SESSION_PRIVATE_KEY");
  if (inline) return inline.replace(/\\n/g, "\n");
  const encoded = env("BIGUL_SESSION_PRIVATE_KEY_B64");
  if (encoded) return Buffer.from(encoded, "base64").toString("utf8");
  throw new ConfigError(["BIGUL_SESSION_PRIVATE_KEY"]);
}

function loadKeys(pem: string): SessionKeys {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new ConfigError(
      ["BIGUL_SESSION_PRIVATE_KEY"],
      "BIGUL_SESSION_PRIVATE_KEY is not a valid PEM private key",
    );
  }
  const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (privateKey.asymmetricKeyType !== "rsa" || modulusLength < 2048)
    throw new ConfigError(
      ["BIGUL_SESSION_PRIVATE_KEY"],
      "BIGUL_SESSION_PRIVATE_KEY must be an RSA key of at least 2048 bits",
    );
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(spki).digest("hex").slice(0, 16);
  return { privateKey, publicKey, kid };
}

/** Signing keys and claims for the session JWT. Throws ConfigError. */
export function getSessionConfig(): SessionConfig {
  const pem = privateKeyPem();
  if (keyCache?.source !== pem) keyCache = { source: pem, keys: loadKeys(pem) };
  return {
    ...keyCache.keys,
    issuer: env("BIGUL_SESSION_ISSUER") ?? "bigul-ui",
    audience: env("BIGUL_SESSION_AUDIENCE") ?? "bigul-backend",
  };
}

export type SsoConfig = { loginUrl: string; appKey: string };

export function getSsoConfig(): SsoConfig {
  const { BIGUL_SSO_APP_KEY } = requireEnv(["BIGUL_SSO_APP_KEY"]);
  return {
    loginUrl: parseUrl(
      "BIGUL_SSO_LOGIN_URL",
      env("BIGUL_SSO_LOGIN_URL") ?? "https://connect.bigul.co/login",
    ),
    appKey: BIGUL_SSO_APP_KEY,
  };
}

export type BigulApiConfig = {
  baseUrl: string;
  source: string;
  apiKey: string;
  apiSecret: string;
  partnerCode: string;
  partnerPassword: string;
  /** Relays for the Bigul calls, in the order to try them; empty = direct. */
  outboundProxyUrls: string[];
};

const PROXY_URLS = "BIGUL_OUTBOUND_PROXY_URLS";

function isProxyUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
    // The relay client decodes these; a raw "%" would fail on every call.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    return false;
  }
  // scheme://[user:password@]host[:port] only. A path, query or fragment
  // usually means an unencoded "/", "?" or "#" in the password.
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}

/**
 * BIGUL_OUTBOUND_PROXY_URLS: comma-separated proxy URLs, primary first.
 * Unset or blank means Bigul is called directly. The values carry relay
 * credentials, so errors name the entry, never its value.
 */
function outboundProxyUrls(): string[] {
  const raw = env(PROXY_URLS);
  if (!raw) return [];
  return raw.split(",").map((entry, index) => {
    const value = entry.trim();
    if (!isProxyUrl(value))
      throw new ConfigError(
        [PROXY_URLS],
        `${PROXY_URLS} entry ${index + 1} is not a valid http(s) proxy URL`,
      );
    return value;
  });
}

export function getBigulApiConfig(): BigulApiConfig {
  const values = requireEnv([
    "BIGUL_API_KEY",
    "BIGUL_API_SECRET",
    "BIGUL_PARTNER_CODE",
    "BIGUL_PARTNER_PASSWORD",
  ]);
  return {
    // Bigul's {{baseUrl}} includes /api/v1; endpoint paths are appended to it.
    baseUrl: parseUrl(
      "BIGUL_API_BASE_URL",
      env("BIGUL_API_BASE_URL") ?? "https://papi.bigul.co/api/v1",
    ),
    source: env("BIGUL_API_SOURCE") ?? "B2B",
    apiKey: values.BIGUL_API_KEY,
    apiSecret: values.BIGUL_API_SECRET,
    partnerCode: values.BIGUL_PARTNER_CODE,
    partnerPassword: values.BIGUL_PARTNER_PASSWORD,
    outboundProxyUrls: outboundProxyUrls(),
  };
}

/** /auth/dev-login works only under `next dev` with AUTH_DEV_LOGIN=true. */
export function isDevLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.AUTH_DEV_LOGIN === "true"
  );
}
