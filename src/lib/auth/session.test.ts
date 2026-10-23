// @vitest-environment node
import { createHash, createPublicKey } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import { NextRequest } from "next/server";
import { ConfigError } from "./config";
import {
  expiredSessionCookie,
  expiredStateCookie,
  mintSession,
  nextSessionExpiry,
  readSession,
  sessionCookie,
  sessionCookieName,
  stateCookie,
  stateCookieName,
  verifySessionToken,
} from "./session";
import { BLANK_AUTH_ENV, testPrivateKeyPem } from "./test-keys";

let pem: string;
let otherPem: string;

beforeAll(() => {
  pem = testPrivateKeyPem();
  otherPem = testPrivateKeyPem();
});

beforeEach(() => {
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const at = (iso: string) => new Date(iso);

describe("nextSessionExpiry", () => {
  it.each([
    ["2026-10-21T00:00:00Z", "2026-10-21T19:00:00.000Z"],
    // 00:29 IST is 18:59 UTC: under five minutes left, so the next day's.
    ["2026-10-22T00:29:00+05:30", "2026-10-22T19:00:00.000Z"],
    ["2026-10-21T18:54:59Z", "2026-10-21T19:00:00.000Z"],
    // Exactly five minutes left is enough.
    ["2026-10-21T18:55:00Z", "2026-10-21T19:00:00.000Z"],
    ["2026-10-21T18:55:01Z", "2026-10-22T19:00:00.000Z"],
    // "After now": 19:00:00 itself rolls to the next day.
    ["2026-10-21T19:00:00Z", "2026-10-22T19:00:00.000Z"],
    ["2026-10-21T19:00:01Z", "2026-10-22T19:00:00.000Z"],
    // 00:30 IST on the 22nd is 19:00 UTC on the 21st.
    ["2026-10-22T00:30:00+05:30", "2026-10-22T19:00:00.000Z"],
    ["2026-10-31T20:00:00Z", "2026-11-01T19:00:00.000Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T19:00:00.000Z"],
  ])("from %s expires at %s", (now, expected) => {
    expect(nextSessionExpiry(at(now)).toISOString()).toBe(expected);
  });

  it("is always at 19:00 UTC, at least five minutes and at most a day and five minutes away", () => {
    const start = at("2026-10-21T00:00:00Z").getTime();
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = start + minute * 60_000 + 13_000;
      const expiry = nextSessionExpiry(now);
      expect(expiry.getUTCHours()).toBe(19);
      expect(expiry.getUTCMinutes()).toBe(0);
      expect(expiry.getTime() - now).toBeGreaterThanOrEqual(5 * 60_000);
      expect(expiry.getTime() - now).toBeLessThanOrEqual(
        24 * 3_600_000 + 5 * 60_000,
      );
    }
  });
});

describe("mintSession", () => {
  it("signs an RS256 JWT with only the contract's claims", async () => {
    const now = at("2026-10-21T10:00:00Z");
    const { token, expiresAt } = await mintSession(" y09042341 ", now);

    const spki = createPublicKey(pem).export({ type: "spki", format: "der" });
    expect(decodeProtectedHeader(token)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: createHash("sha256").update(spki).digest("hex").slice(0, 16),
    });
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "jti", "sub"].sort(),
    );
    expect(claims).toMatchObject({
      iss: "bigul-ui",
      aud: "bigul-backend",
      sub: "Y09042341",
      iat: now.getTime() / 1000,
      exp: at("2026-10-21T19:00:00Z").getTime() / 1000,
    });
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(expiresAt.toISOString()).toBe("2026-10-21T19:00:00.000Z");

    const second = await mintSession("Y09042341", now);
    expect(decodeJwt(second.token).jti).not.toBe(claims.jti);
  });

  it("uses the configured issuer and audience", async () => {
    vi.stubEnv("BIGUL_SESSION_ISSUER", "ui-staging");
    vi.stubEnv("BIGUL_SESSION_AUDIENCE", "backend-staging");
    const { token } = await mintSession("Y1");
    expect(decodeJwt(token)).toMatchObject({
      iss: "ui-staging",
      aud: "backend-staging",
    });
  });

  it.each([
    ["literal \\n escapes", "escaped"],
    ["base64", "base64"],
  ] as const)("accepts a key given with %s", async (_, form) => {
    vi.stubEnv(
      "BIGUL_SESSION_PRIVATE_KEY",
      form === "escaped" ? pem.replace(/\n/g, "\\n") : "",
    );
    vi.stubEnv(
      "BIGUL_SESSION_PRIVATE_KEY_B64",
      form === "base64" ? Buffer.from(pem).toString("base64") : "",
    );
    const { token } = await mintSession("Y1");
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY_B64", "");
    expect(await verifySessionToken(token)).toMatchObject({ clientCode: "Y1" });
  });

  it("fails with a ConfigError when no usable key is configured", async () => {
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", "");
    await expect(mintSession("Y1")).rejects.toBeInstanceOf(ConfigError);
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", "not a key");
    await expect(mintSession("Y1")).rejects.toBeInstanceOf(ConfigError);
  });

  it.each(["", "Y 1", "Y1;DROP", "A".repeat(33)])(
    "refuses the malformed client code %j",
    async (code) => {
      await expect(mintSession(code)).rejects.toThrow("Invalid client code");
    },
  );
});

describe("verifySessionToken", () => {
  it("returns the client code and expiry of a valid token", async () => {
    const { token, expiresAt } = await mintSession("Y09042341");
    expect(await verifySessionToken(token)).toEqual({
      clientCode: "Y09042341",
      expiresAt,
    });
  });

  it("rejects an expired token", async () => {
    const now = at("2026-10-21T10:00:00Z");
    const { token } = await mintSession("Y1", now);
    expect(await verifySessionToken(token, now)).not.toBeNull();
    expect(
      await verifySessionToken(token, at("2026-10-21T19:00:01Z")),
    ).toBeNull();
  });

  it("rejects tokens for another issuer or audience", async () => {
    vi.stubEnv("BIGUL_SESSION_AUDIENCE", "someone-else");
    const { token } = await mintSession("Y1");
    vi.stubEnv("BIGUL_SESSION_AUDIENCE", "");
    expect(await verifySessionToken(token)).toBeNull();

    vi.stubEnv("BIGUL_SESSION_ISSUER", "someone-else");
    const other = await mintSession("Y1");
    vi.stubEnv("BIGUL_SESSION_ISSUER", "");
    expect(await verifySessionToken(other.token)).toBeNull();
  });

  it("rejects a token signed with another key", async () => {
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", otherPem);
    const { token } = await mintSession("Y1");
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { token } = await mintSession("Y1");
    const [header, , signature] = token.split(".");
    const payload = Buffer.from(
      JSON.stringify({ ...decodeJwt(token), sub: "Y2" }),
    ).toString("base64url");
    expect(
      await verifySessionToken(`${header}.${payload}.${signature}`),
    ).toBeNull();
  });

  it("rejects HS256 and unsigned tokens", async () => {
    const claims = {
      iss: "bigul-ui",
      aud: "bigul-backend",
      sub: "Y1",
      jti: "x",
    };
    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-shared-secret-of-32-characters!"));
    expect(await verifySessionToken(hs256)).toBeNull();

    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ ...claims, iat: now, exp: now + 3600 })}.`;
    expect(await verifySessionToken(unsigned)).toBeNull();
  });

  it("rejects a signed token whose subject is not a normalised client code", async () => {
    const { createPrivateKey } = await import("node:crypto");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("bigul-ui")
      .setAudience("bigul-backend")
      .setSubject("y1")
      .setJti("x")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(createPrivateKey(pem));
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("returns null for garbage, a missing token or a missing key", async () => {
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken("not.a.jwt")).toBeNull();
    const { token } = await mintSession("Y1");
    vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", "");
    expect(await verifySessionToken(token)).toBeNull();
  });
});

describe("cookie options", () => {
  it("makes the session cookie httpOnly, Lax and site-wide, Secure in production", () => {
    const expires = at("2026-10-21T19:00:00Z");
    expect(sessionCookie("jwt", expires)).toEqual({
      name: "bigul_session",
      value: "jwt",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      expires,
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie("jwt", expires)).toEqual({
      name: "__Host-bigul_session",
      value: "jwt",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires,
    });
  });

  it("makes the SSO state cookie site-wide for ten minutes, __Host- in production", () => {
    expect(stateCookie("v")).toMatchObject({
      name: "bigul_sso_state",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    expect(expiredStateCookie()).toMatchObject({
      name: "bigul_sso_state",
      value: "",
      path: "/",
      maxAge: 0,
    });
    vi.stubEnv("NODE_ENV", "production");
    const state = stateCookie("v");
    expect(state).toMatchObject({
      name: "__Host-bigul_sso_state",
      secure: true,
      path: "/",
    });
    expect(state).not.toHaveProperty("domain");
  });

  it("clears the prefixed cookies in production with the attributes the prefixes need", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieName()).toBe("__Host-bigul_session");
    expect(stateCookieName()).toBe("__Host-bigul_sso_state");
    const session = expiredSessionCookie();
    expect(session).toMatchObject({
      name: "__Host-bigul_session",
      value: "",
      secure: true,
      path: "/",
      maxAge: 0,
    });
    expect(session).not.toHaveProperty("domain");
    const state = expiredStateCookie();
    expect(state).toMatchObject({
      name: "__Host-bigul_sso_state",
      value: "",
      secure: true,
      path: "/",
      maxAge: 0,
    });
    expect(state).not.toHaveProperty("domain");
  });

  it("reads the session only from the cookie name of the environment", async () => {
    const { token } = await mintSession("Y1");
    const read = (cookie: string) =>
      readSession(
        new NextRequest("http://localhost:3000/", { headers: { cookie } }),
      );
    expect(await read(`bigul_session=${token}`)).toMatchObject({
      clientCode: "Y1",
    });
    expect(await read(`__Host-bigul_session=${token}`)).toBeNull();

    vi.stubEnv("NODE_ENV", "production");
    expect(await read(`bigul_session=${token}`)).toBeNull();
    expect(await read(`__Host-bigul_session=${token}`)).toMatchObject({
      clientCode: "Y1",
    });
  });
});
