// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, getBigulApiConfig } from "./config";
import { BLANK_AUTH_ENV } from "./test-keys";

const NAME = "BIGUL_OUTBOUND_PROXY_URLS";
const PRIMARY = "http://bigul:s3cr%40t@203.0.113.10:3128";
const SECONDARY = "https://bigul:s3cr%40t@relay-2.example.test:3129";

beforeEach(() => {
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_API_KEY", "api-key");
  vi.stubEnv("BIGUL_API_SECRET", "api-secret");
  vi.stubEnv("BIGUL_PARTNER_CODE", "PARTNER01");
  vi.stubEnv("BIGUL_PARTNER_PASSWORD", "partner-password");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const proxyUrls = () => getBigulApiConfig().outboundProxyUrls;

describe(NAME, () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "  \t "],
  ])("means direct calls when %s", (_, value) => {
    vi.stubEnv(NAME, value);
    expect(proxyUrls()).toEqual([]);
  });

  it("keeps the order given, primary first, trimming whitespace", () => {
    vi.stubEnv(NAME, ` ${PRIMARY} ,\n${SECONDARY}  `);
    expect(proxyUrls()).toEqual([PRIMARY, SECONDARY]);
  });

  it("accepts a single relay, with or without credentials or a trailing slash", () => {
    vi.stubEnv(NAME, "http://203.0.113.10:3128/");
    expect(proxyUrls()).toEqual(["http://203.0.113.10:3128/"]);
  });

  it.each([
    ["not a URL", "relay-1:3128", 1],
    ["another scheme", "socks5://bigul:pw@203.0.113.10:1080", 1],
    ["no host", "http://", 1],
    ["an empty entry", `${PRIMARY},,${SECONDARY}`, 2],
    ["a trailing comma", `${PRIMARY},`, 2],
    ["a path", `${PRIMARY}/squid`, 1],
    [
      "an unencoded '/' in the password",
      "http://bigul:pa/ss@203.0.113.10:3128",
      1,
    ],
    [
      "an unencoded '#' in the password",
      "http://bigul:pa#ss@203.0.113.10:3128",
      1,
    ],
    [
      "an unencoded '?' in the password",
      "http://bigul:pa?ss@203.0.113.10:3128",
      1,
    ],
    [
      "an unencoded '%' in the password",
      "http://bigul:50%off@203.0.113.10:3128",
      1,
    ],
    ["a bad second entry", `${PRIMARY},ftp://bigul:pa55@203.0.113.11:21`, 2],
  ])(
    "rejects %s with a ConfigError naming the variable, not the value",
    (_, value, entry) => {
      vi.stubEnv(NAME, value);
      let error: unknown;
      try {
        getBigulApiConfig();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.missing).toEqual([NAME]);
      expect(configError.message).toBe(
        `${NAME} entry ${entry} is not a valid http(s) proxy URL`,
      );
      expect(configError.cause).toBeUndefined();
      const shown = JSON.stringify({
        ...configError,
        message: configError.message,
      });
      for (const part of [
        "pa55",
        "pa/ss",
        "pa#ss",
        "pa?ss",
        "50%off",
        "s3cr",
        "203.0.113",
        "relay-1",
      ])
        expect(shown).not.toContain(part);
    },
  );
});
