const BASE = "http://next-path.invalid";
// Sign-in and API routes are never a useful place to land after signing in.
const EXCLUDED = /^\/(?:login|auth|api)(?:\/|$)/i;

/**
 * A same-origin path to return to after signing in, or "/". Rejects absolute
 * and protocol-relative URLs, backslashes and control characters.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) return "/";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /\p{Cc}/u.test(value)
  )
    return "/";
  let url: URL;
  let decodedPath: string;
  try {
    url = new URL(value, BASE);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  if (EXCLUDED.test(url.pathname) || EXCLUDED.test(decodedPath)) return "/";
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can normalise "/.//evil.com" into protocol-relative "//evil.com".
  if (path.startsWith("//") || path.startsWith("/\\")) return "/";
  return path;
}
