import { Client } from "@langchain/langgraph-sdk";
import { authFetch } from "@/lib/auth-fetch";

export function createClient(
  apiUrl: string,
  apiKey: string | undefined,
  authScheme: string | undefined,
) {
  return new Client({
    apiKey,
    apiUrl,
    // Every SDK request (JSON and streams) goes through authFetch's 401 handling.
    callerOptions: { fetch: authFetch },
    ...(authScheme && {
      defaultHeaders: {
        "X-Auth-Scheme": authScheme,
      },
    }),
  });
}
