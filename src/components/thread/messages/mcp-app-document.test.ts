import { describe, expect, it } from "vitest";
import { wrapGuestHtml } from "./mcp-app";

describe("self-contained report documents", () => {
  it("applies restrictions and embedded fonts before guest scripts in standards mode", () => {
    const html = wrapGuestHtml(
      "<!doctype html><html><head><script>start()</script></head><body></body></html>",
      "dark",
      "<style>embedded-font</style>",
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("start()"),
    );
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("font-src data:");
    expect(html).toContain("embedded-font");
  });

  it("does not splice policy into fake head tags inside comments or script strings", () => {
    for (const html of [
      "<!-- <head> --><script>start()</script>",
      '<script>const tag="<head>";start()</script>',
    ]) {
      const wrapped = wrapGuestHtml(html, "light");
      expect(wrapped.endsWith(html)).toBe(true);
      expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(
        wrapped.indexOf(html),
      );
    }
  });
});
