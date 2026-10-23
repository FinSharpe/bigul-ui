const CLIENT_CODE_PATTERN = /^[A-Z0-9_-]{1,32}$/;

/** Bigul client code, trimmed and uppercased; null unless it is well formed. */
export function normalizeClientCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return CLIENT_CODE_PATTERN.test(code) ? code : null;
}
