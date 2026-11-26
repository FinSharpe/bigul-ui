// Which Bigul app a client came from, keyed on the platform code its WebView
// sends in X-Bigul-Platform. Codes not listed here get the default theme.

export type AppTheme = "bigul" | "superapp";

export const DEFAULT_THEME: AppTheme = "bigul";

const THEMES: Readonly<Record<string, AppTheme>> = { "99": "superapp" };

const isTheme = (value: unknown): value is AppTheme =>
  value === "bigul" || value === "superapp";

/** The theme for a platform code; the default for anything unknown. */
export function themeFor(platform?: string | null): AppTheme {
  if (!platform || !Object.hasOwn(THEMES, platform)) return DEFAULT_THEME;
  return THEMES[platform];
}

/** A stored theme value, or the default when it is not one we know. */
export function parseTheme(value?: string | null): AppTheme {
  return isTheme(value) ? value : DEFAULT_THEME;
}
