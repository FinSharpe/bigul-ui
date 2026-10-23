let redirecting = false;

/** Indirection so tests can observe the redirect (jsdom's location is not spyable). */
export const loginNavigation = {
  assign(url: string) {
    window.location.assign(url);
  },
};

/** Allows another redirect (tests). */
export function resetAuthRedirect() {
  redirecting = false;
}

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url;
}

function isSameOriginApi(input: RequestInfo | URL): boolean {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const url = new URL(raw, window.location.href);
    return (
      url.origin === window.location.origin &&
      (url.pathname === "/api" || url.pathname.startsWith("/api/"))
    );
  } catch {
    return false;
  }
}

/**
 * fetch for the LangGraph proxy. A 401 from this site's /api means the
 * session is gone: send the browser to sign in, once per page.
 */
export async function authFetch(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const response = await globalThis.fetch(...args);
  if (
    response?.status === 401 &&
    !redirecting &&
    typeof window !== "undefined" &&
    isSameOriginApi(args[0])
  ) {
    redirecting = true;
    const { pathname, search } = window.location;
    loginNavigation.assign(
      `/login?next=${encodeURIComponent(`${pathname}${search}`)}`,
    );
  }
  return response;
}
