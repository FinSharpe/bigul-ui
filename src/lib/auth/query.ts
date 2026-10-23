/** The query string of a URL exactly as sent: no "?", no fragment, nothing decoded. */
export function rawQueryString(url: string): string {
  const start = url.indexOf("?");
  if (start === -1) return "";
  const query = url.slice(start + 1);
  const hash = query.indexOf("#");
  return hash === -1 ? query : query.slice(0, hash);
}

/**
 * Parses a raw query string with decodeURIComponent only, so "+" stays "+"
 * (URLSearchParams would turn it into a space and corrupt Bigul tokens).
 * This reads a token correctly both as Bigul sent it and as Next re-serialises
 * it for handlers ("+" kept, "/" as %2F). Repeated or undecodable parameters
 * are dropped: ambiguous input is never used.
 */
export function parseRawQuery(query: string): Map<string, string> {
  const values = new Map<string, string>();
  const rejected = new Set<string>();
  for (const part of query.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const split = part.indexOf("=");
    const rawKey = split === -1 ? part : part.slice(0, split);
    const rawValue = split === -1 ? "" : part.slice(split + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      continue;
    }
    if (rejected.has(key)) continue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      rejected.add(key);
      values.delete(key);
      continue;
    }
    if (values.has(key)) {
      rejected.add(key);
      values.delete(key);
      continue;
    }
    values.set(key, value);
  }
  return values;
}
