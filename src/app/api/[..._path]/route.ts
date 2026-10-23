import { initApiPassthrough } from "langgraph-nextjs-api-passthrough";
import { NextRequest, NextResponse } from "next/server";
import { noStore } from "@/lib/auth/responses";
import { readSession } from "@/lib/auth/session";

// LangGraph proxy. Every call needs a valid bigul_session (checked here, not
// only in proxy.ts) and is sent upstream as `authorization: Bearer <session JWT>`.

export const runtime = "nodejs";
// Agent runs stream for minutes. Needs Vercel Fluid compute (see README).
export const maxDuration = 300;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
// Lets a stream join or reconnect resume after the last event it saw.
const LAST_EVENT_ID = /^[\x21-\x7e]{1,128}$/;
// The passthrough forwards every client x-* header and authorization; none of
// them may reach LangGraph. The cookie holds the session itself.
const isClientCredential = (name: string) =>
  name === "authorization" || name === "cookie" || name.startsWith("x-");
// Node's fetch has already decoded the upstream body, so these no longer
// describe it; the rest are hop-by-hop.
const STALE_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

async function sanitize(request: NextRequest): Promise<NextRequest> {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!isClientCredential(name.toLowerCase())) headers.set(name, value);
  });
  return new NextRequest(request.url, {
    method: request.method,
    headers,
    ...(BODY_METHODS.has(request.method) && { body: await request.text() }),
  });
}

function handler(method: Method) {
  return async (request: NextRequest): Promise<Response> => {
    const session = await readSession(request);
    if (!session)
      return noStore(
        NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
      );
    const apiUrl = process.env.LANGGRAPH_API_URL?.trim();
    if (!apiUrl)
      return noStore(
        NextResponse.json(
          { error: "upstream not configured" },
          { status: 503 },
        ),
      );
    const apiKey = process.env.LANGSMITH_API_KEY?.trim();
    const passthrough = initApiPassthrough({
      apiUrl,
      // Only until LangGraph custom auth is live; remove the env var after.
      ...(apiKey ? { apiKey } : {}),
      runtime: "nodejs",
      disableWarningLog: true,
      // Lowercase keys, so they replace rather than join any other value.
      headers: async (req) => {
        const lastEventId = req.headers.get("last-event-id");
        return {
          authorization: `Bearer ${session.token}`,
          ...(lastEventId && LAST_EVENT_ID.test(lastEventId)
            ? { "last-event-id": lastEventId }
            : {}),
        };
      },
    });
    const response = await passthrough[method](await sanitize(request));
    if (response.status === 401) {
      // Our session is valid, so this is a key or claim mismatch with the
      // backend. Passing the 401 on would bounce the browser through /login
      // and back forever; only our own no-session 401 means "sign in".
      await response.body?.cancel().catch(() => {});
      console.error(
        "[bigul-auth] LangGraph rejected a valid session token; check that BIGUL_SESSION_PUBLIC_KEY, BIGUL_SESSION_ISSUER and BIGUL_SESSION_AUDIENCE match on both sides",
      );
      return noStore(
        NextResponse.json({ error: "upstream_auth" }, { status: 502 }),
      );
    }
    for (const name of STALE_RESPONSE_HEADERS) response.headers.delete(name);
    return response;
  };
}

export const GET = handler("GET");
export const POST = handler("POST");
export const PUT = handler("PUT");
export const PATCH = handler("PATCH");
export const DELETE = handler("DELETE");

// CORS preflight stays unauthenticated, as in the passthrough.
export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "content-location",
    },
  });
}
