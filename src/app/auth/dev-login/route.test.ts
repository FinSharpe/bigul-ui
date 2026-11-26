// @vitest-environment node
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { decodeJwt } from "jose";
import { NextRequest } from "next/server";
import { verifySessionToken } from "@/lib/auth/session";
import { BLANK_AUTH_ENV, testPrivateKeyPem } from "@/lib/auth/test-keys";
import { GET } from "./route";

let pem: string;

beforeAll(() => {
  pem = testPrivateKeyPem();
});

beforeEach(() => {
  for (const [name, value] of Object.entries(BLANK_AUTH_ENV))
    vi.stubEnv(name, value);
  vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", pem);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const devLogin = (query = "?client=test01") =>
  GET(new NextRequest(`http://localhost:3000/auth/dev-login${query}`));

describe("GET /auth/dev-login", () => {
  it.each([
    ["production with the flag", "production", "true"],
    ["test with the flag", "test", "true"],
    ["development without the flag", "development", ""],
    ["development with another value", "development", "1"],
  ])("does not exist in %s", async (_, nodeEnv, flag) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("AUTH_DEV_LOGIN", flag);
    const response = await devLogin();
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  describe("under next dev with AUTH_DEV_LOGIN=true", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("AUTH_DEV_LOGIN", "true");
    });

    it("signs in as the given client code", async () => {
      const response = await devLogin("?client=test01&next=%2F%3Fa%3D1");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/?a=1",
      );
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("bigul_session="))!;
      const jwt = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
      expect(await verifySessionToken(jwt)).toMatchObject({
        clientCode: "TEST01",
      });
    });

    it("never redirects off-site", async () => {
      const response = await devLogin("?client=test01&next=%2F.%2F%2Fevil.com");
      expect(response.headers.get("location")).toBe("http://localhost:3000/");
    });

    it("refuses a malformed client code", async () => {
      const response = await devLogin("?client=a%20b");
      expect(response.status).toBe(303);
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("verify");
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    const sessionJwt = (response: Response) =>
      decodeURIComponent(
        response.headers
          .getSetCookie()
          .find((value) => value.startsWith("bigul_session="))!
          .split(";")[0]
          .split("=")[1],
      );
    const appCookie = (response: Response) =>
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith("bigul_app="));

    it("adds no plt claim and no app cookie without a platform", async () => {
      const response = await devLogin();
      expect(decodeJwt(sessionJwt(response)).plt).toBeUndefined();
      expect(appCookie(response)).toBeUndefined();
    });

    it.each([
      ["99", "superapp"],
      ["7", "bigul"],
    ])("signs in as platform %s's WebView would", async (platform, theme) => {
      const response = await devLogin(`?client=test01&platform=${platform}`);
      expect(response.status).toBe(303);
      expect(decodeJwt(sessionJwt(response)).plt).toBe(platform);
      expect(appCookie(response)).toMatch(new RegExp(`^bigul_app=${theme};`));
    });

    it.each(["1000", "abc", "", "9%209"])(
      "refuses platform=%j",
      async (platform) => {
        const response = await devLogin(`?client=test01&platform=${platform}`);
        expect(
          new URL(response.headers.get("location")!).searchParams.get("error"),
        ).toBe("verify");
        expect(response.headers.getSetCookie()).toEqual([]);
      },
    );

    it("reports a missing signing key", async () => {
      vi.stubEnv("BIGUL_SESSION_PRIVATE_KEY", "");
      const response = await devLogin();
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("config");
    });
  });
});
