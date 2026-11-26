import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFontCss } from "./mcp-app-fonts";

afterEach(() => vi.unstubAllGlobals());

const stubFetch = () => {
  const fetch = vi.fn(
    async (_url: string) =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("reportFontCss", () => {
  it("inlines Inter 400/500/600 for the default theme, as before", async () => {
    const fetch = stubFetch();
    const css = await reportFontCss("bigul");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/fonts/report/Inter-400.subset.woff2",
      "/fonts/report/Inter-500.subset.woff2",
      "/fonts/report/Inter-600.subset.woff2",
    ]);
    expect(css).toBe(
      `<style>${[400, 500, 600]
        .map(
          (weight) =>
            `@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,AQID) format('woff2');}`,
        )
        .join("")}</style>`,
    );
  });

  it("inlines DM Sans for the Super App, also under the Inter name reports ask for", async () => {
    const fetch = stubFetch();
    const css = await reportFontCss("superapp");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/fonts/report/DMSans-latin.woff2",
      "/fonts/report/DMSans-latin-ext.woff2",
    ]);
    expect(css).toContain("font-family:Inter;");
    expect(css).toContain('font-family:"DM Sans";');
    expect(css).toContain("font-weight:400 600;");
    expect(css).toContain("unicode-range:");
  });
});
