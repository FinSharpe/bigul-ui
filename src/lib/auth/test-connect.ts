import { vi } from "vitest";
import { accessToken } from "./test-tokens";

// Test-only: a fetch stand-in for Bigul's partner API and Connect's SSO
// bypass. Connect passes the request through a couple of its own pages (302s
// carrying its cookies), then redirects to our callback, or shows its login
// page when it refuses the token. The step names here are made up.

export const CONNECT = "https://connect.bigul.co";
export const OUR_SITE = "https://bigul-ai.vercel.app";
export const API_BASE = "https://bigul.test";

export type ConnectOutcome =
  | "callback"
  | "docs-shape"
  | "login-page"
  | "failed-status"
  | "bad-state"
  | "no-access-token"
  | "elsewhere"
  | "foreign-host"
  | "insecure"
  | "loop"
  | "503"
  | "429";

export type FakeBigulOptions = {
  outcome?: ConnectOutcome;
  /** The client Connect signs in. */
  clientCode?: string;
  /** Answer of get-client-profile. */
  profile?: "ok" | "401" | "503";
};

const redirect = (location: string, cookies: string[] = []) =>
  new Response(null, {
    status: 302,
    headers: [
      ["location", location],
      ...cookies.map((cookie): [string, string] => ["set-cookie", cookie]),
    ],
  });

const page = (status = 200) =>
  new Response(
    '<!doctype html><title>Get Started</title><form method="POST" action="/send-otp"><input name="username"></form>',
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** The raw query of a request URL (Bigul tokens contain "+"). */
const rawQuery = (url: string) => url.slice(url.indexOf("?") + 1);
const rawParam = (url: string, name: string) =>
  rawQuery(url)
    .split("&")
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export function fakeBigul(options: FakeBigulOptions = {}) {
  const outcome = options.outcome ?? "callback";
  const clientCode = options.clientCode ?? "TEST0001";
  const token = accessToken(clientCode);
  const fetchMock = vi.fn(
    async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith(OUR_SITE))
        throw new Error("the bypass must never request our own site");
      if (url.includes("/partner/auth/session-login"))
        return Response.json({
          status: true,
          data: {
            sessionId: "partner-1",
            expiryTime: new Date(Date.now() + 3_600_000).toISOString(),
          },
        });
      if (url.includes("/auth/connect/get-client-profile")) {
        if (options.profile === "401")
          return Response.json(
            { status: false, message: "Invalid or expired token" },
            { status: 401 },
          );
        if (options.profile === "503") return new Response("", { status: 503 });
        return Response.json({
          status: true,
          data: [{ clientcode: `${clientCode} ` }],
        });
      }
      if (!url.startsWith(CONNECT)) throw new Error(`unexpected ${url}`);

      const path = new URL(url).pathname;
      const state = rawParam(url, "state") ?? "";
      if (path === "/login")
        return url.includes("&platform=")
          ? redirect(`/login-step?${rawQuery(url)}`, [
              "_csrf=csrf-1; Path=/; HttpOnly; SameSite=Lax",
              "connect.sid=sid-1; Path=/; HttpOnly; SameSite=Lax",
            ])
          : page();
      if (path === "/login-step")
        return outcome === "loop"
          ? redirect(`/login-step?${rawQuery(url)}`)
          : redirect(`${CONNECT}/hand-back-step?${rawQuery(url)}`);
      if (path !== "/hand-back-step") throw new Error(`unexpected ${url}`);

      const handBack = (base: string, query: string) =>
        redirect(`${base}?${query}`);
      switch (outcome) {
        case "callback":
          return handBack(
            `${OUR_SITE}/auth/callback`,
            `status=success&state=${state}&access_token=${token}&client_code=${clientCode}%20`,
          );
        case "docs-shape":
          return handBack(
            `${OUR_SITE}/`,
            `login_success=true&userid=${clientCode}&state=${state}&token=${token}`,
          );
        case "failed-status":
          return handBack(
            `${OUR_SITE}/auth/callback`,
            `status=failed&state=${state}`,
          );
        case "bad-state":
          return handBack(
            `${OUR_SITE}/auth/callback`,
            `status=success&state=other&access_token=${token}&client_code=${clientCode}`,
          );
        case "no-access-token":
          return handBack(
            `${OUR_SITE}/auth/callback`,
            `status=success&state=${state}&client_code=${clientCode}`,
          );
        case "elsewhere":
          return handBack(
            `${OUR_SITE}/somewhere`,
            `status=success&state=${state}&access_token=${token}&client_code=${clientCode}`,
          );
        case "foreign-host":
          return handBack(
            "https://evil.example/auth/callback",
            `status=success&state=${state}&access_token=${token}&client_code=${clientCode}`,
          );
        case "insecure":
          return handBack(
            "http://bigul-ai.vercel.app/auth/callback",
            `status=success&state=${state}&access_token=${token}&client_code=${clientCode}`,
          );
        case "login-page":
          return redirect("/login");
        case "503":
          return new Response("", { status: 503 });
        case "429":
          return new Response("", { status: 429 });
        default:
          throw new Error(`unhandled ${outcome}`);
      }
    },
  );
  /** Connect requests, in order. */
  const connectCalls = () =>
    fetchMock.mock.calls
      .filter(([input]) => String(input).startsWith(CONNECT))
      .map(([input, init]) => ({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        redirect: init?.redirect,
      }));
  return { fetchMock, connectCalls, accessToken: token };
}
