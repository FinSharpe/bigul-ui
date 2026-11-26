import { parseTheme, type AppTheme } from "@/lib/platform";

// Report views ask for "Inter" by name (FinSharpe's fs_tokens.css), and the
// frame may only load data: fonts, so the app's face is inlined. In the Super
// App the DM Sans files are declared under "Inter" too, so reports draw in the
// app's font without any change on the MCP side.
type ReportFont = {
  url: string;
  family: string[];
  weight: string;
  unicodeRange?: string;
};

const REPORT_FONTS: Record<AppTheme, ReportFont[]> = {
  bigul: [400, 500, 600].map((weight) => ({
    url: `/fonts/report/Inter-${weight}.subset.woff2`,
    family: ["Inter"],
    weight: String(weight),
  })),
  superapp: [
    {
      url: "/fonts/report/DMSans-latin.woff2",
      family: ["Inter", "DM Sans"],
      weight: "400 600",
      unicodeRange:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
    {
      url: "/fonts/report/DMSans-latin-ext.woff2",
      family: ["Inter", "DM Sans"],
      weight: "400 600",
      unicodeRange:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
};

/** The app theme the page was rendered in (the root layout's data-theme). */
export function pageTheme(): AppTheme {
  return parseTheme(document.documentElement.dataset.theme);
}

const fontPromises: Partial<Record<AppTheme, Promise<string>>> = {};
export function reportFontCss(theme: AppTheme) {
  return (fontPromises[theme] ??= Promise.all(
    REPORT_FONTS[theme].map(async (font) => {
      const response = await fetch(font.url, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error("Font unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const range = font.unicodeRange
        ? `unicode-range:${font.unicodeRange};`
        : "";
      return font.family
        .map(
          (family) =>
            `@font-face{font-family:${family.includes(" ") ? `"${family}"` : family};font-style:normal;font-weight:${font.weight};font-display:block;${range}src:url(data:font/woff2;base64,${btoa(binary)}) format('woff2');}`,
        )
        .join("");
    }),
  )
    .then((fonts) => `<style>${fonts.join("")}</style>`)
    .catch(() => {
      delete fontPromises[theme];
      return "";
    }));
}
