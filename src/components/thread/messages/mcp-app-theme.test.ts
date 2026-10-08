import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { stampGuestTheme, useHostTheme, type HostTheme } from "./mcp-app-theme";

const stampFor = (theme: string) =>
  `<meta name="color-scheme" content="${theme}">` +
  `<script>document.documentElement.setAttribute("data-theme","${theme}");</script>`;

describe("stampGuestTheme", () => {
  it("stamps the theme just inside <head>, ahead of the guest's own content", () => {
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><script>boot()</script></head><body></body></html>';
    expect(stampGuestTheme(html, "dark")).toBe(
      `<!doctype html><html lang="en"><head>${stampFor("dark")}<meta charset="utf-8"><script>boot()</script></head><body></body></html>`,
    );
  });

  it("stamps light as readily as dark", () => {
    expect(stampGuestTheme("<head></head>", "light")).toBe(
      `<head>${stampFor("light")}</head>`,
    );
  });

  it("finds a <head> that carries attributes, in any case", () => {
    expect(stampGuestTheme('<HEAD data-x="1"><title>t</title>', "light")).toBe(
      `<HEAD data-x="1">${stampFor("light")}<title>t</title>`,
    );
  });

  it("never mistakes <header> for <head>", () => {
    const html = "<html><body><header>Report</header></body></html>";
    expect(stampGuestTheme(html, "dark")).toBe(
      `<html>${stampFor("dark")}<body><header>Report</header></body></html>`,
    );
  });

  it("falls back to <html>, then to the very front of the document", () => {
    expect(
      stampGuestTheme('<html class="x"><body></body></html>', "dark"),
    ).toBe(`<html class="x">${stampFor("dark")}<body></body></html>`);
    expect(stampGuestTheme("<p>bare fragment</p>", "dark")).toBe(
      `${stampFor("dark")}<p>bare fragment</p>`,
    );
  });

  it("leaves the stamped attribute on the parsed document's root", () => {
    const stamped = stampGuestTheme(
      "<!doctype html><html><head><title>t</title></head><body></body></html>",
      "dark",
    );
    const doc = new DOMParser().parseFromString(stamped, "text/html");
    expect(
      doc.head
        .querySelector('meta[name="color-scheme"]')
        ?.getAttribute("content"),
    ).toBe("dark");
    // The stamp is the first thing in <head>, so it runs before any guest script.
    expect(doc.head.children[0].tagName).toBe("META");
    expect(doc.head.children[1].tagName).toBe("SCRIPT");
    expect(doc.head.children[1].textContent).toBe(
      'document.documentElement.setAttribute("data-theme","dark");',
    );
  });

  // What a browser makes of a stamped document (jsdom does not run scripts).
  const parse = (stamped: string) =>
    new DOMParser().parseFromString(stamped, "text/html");
  const stampScript = (theme: string) =>
    `document.documentElement.setAttribute("data-theme","${theme}");`;

  it("finds <head> behind a doctype, whitespace and an <html> with attributes", () => {
    // The shape of the report views themselves.
    const before = '\n<!DOCTYPE html>\n<html lang="en" class=no-js data-app>\n';
    expect(
      stampGuestTheme(`${before}  <head>\n<meta charset="utf-8">`, "light"),
    ).toBe(`${before}  <head>${stampFor("light")}\n<meta charset="utf-8">`);
  });

  it("is not taken in by a comment that mentions <head> ahead of the real one", () => {
    const html =
      "<!-- theme hook: see <head> below --><!doctype html><html><head><title>t</title></head><body></body></html>";
    const stamped = stampGuestTheme(html, "light");

    // In front of the document, not inside the comment — where it would be lost.
    expect(stamped).toBe(stampFor("light") + html);
    const { head } = parse(stamped);
    expect(head.children[0].getAttribute("content")).toBe("light");
    expect(head.children[1].textContent).toBe(stampScript("light"));
    expect(head.querySelector("title")?.textContent).toBe("t");
  });

  it("never splices into a guest script that only mentions <head>", () => {
    // A document that leaves the optional <head> tag out.
    const guest = 'var tags = ["<head>", "<body>"]; boot(tags);';
    const html = `<!doctype html><title>t</title><script>${guest}</script><p>report</p>`;
    const stamped = stampGuestTheme(html, "dark");

    expect(stamped).toBe(stampFor("dark") + html);
    // The guest's script is whole, and runs after the stamp.
    expect(
      [...parse(stamped).querySelectorAll("script")].map((s) => s.textContent),
    ).toEqual([stampScript("dark"), guest]);
  });

  it("reads a quoted attribute to its closing quote, whatever is inside", () => {
    expect(
      stampGuestTheme('<html data-note="a > b"><body></body></html>', "dark"),
    ).toBe(`<html data-note="a > b">${stampFor("dark")}<body></body></html>`);
    expect(
      stampGuestTheme(
        "<html data-tags='<head>'><head><title>t</title></head></html>",
        "dark",
      ),
    ).toBe(
      `<html data-tags='<head>'><head>${stampFor("dark")}<title>t</title></head></html>`,
    );
  });

  it.each([
    ["a quote inside an unquoted value", '<html data-x=a"b><head></head>'],
    ["a self-closing <head/>", "<head/><title>t</title>"],
    ["text ahead of the document", "report <html><head></head></html>"],
    ["a comment ahead of <html>", "<!-- c --><html><head></head></html>"],
  ])("goes to the very front rather than guess, given %s", (_label, html) => {
    const stamped = stampGuestTheme(html, "dark");
    expect(stamped).toBe(stampFor("dark") + html);
    expect(parse(stamped).querySelector("script")?.textContent).toBe(
      stampScript("dark"),
    );
  });

  it("writes nothing into the document for a value that is not a theme", () => {
    const html = "<html><head></head></html>";
    for (const notATheme of ["system", "", '"><script>alert(1)</script>']) {
      expect(stampGuestTheme(html, notATheme as HostTheme)).toBe(html);
    }
    expect(stampGuestTheme(html, undefined as unknown as HostTheme)).toBe(html);
  });
});

describe("useHostTheme", () => {
  const setDarkClass = async (on: boolean) => {
    await act(async () => {
      document.documentElement.classList.toggle("dark", on);
      // MutationObserver delivers on a microtask.
      await Promise.resolve();
    });
  };

  afterEach(() => {
    // Unmount first: a mounted hook would see the reset as a theme switch.
    cleanup();
    document.documentElement.className = "";
  });

  it("is light when nothing has put the app in dark mode", () => {
    const { result } = renderHook(() => useHostTheme());
    expect(result.current).toBe("light");
  });

  it("is dark when the app's dark class is on <html>", () => {
    document.documentElement.classList.add("dark");
    const { result } = renderHook(() => useHostTheme());
    expect(result.current).toBe("dark");
  });

  it("follows the app when it switches theme, in both directions", async () => {
    const { result } = renderHook(() => useHostTheme());
    await setDarkClass(true);
    expect(result.current).toBe("dark");
    await setDarkClass(false);
    expect(result.current).toBe("light");
  });

  it("stops watching the app once nothing is using it", () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    try {
      const { unmount } = renderHook(() => useHostTheme());
      const watching = observe.mock.contexts.filter(
        (_observer, call) =>
          observe.mock.calls[call][0] === document.documentElement,
      );
      expect(watching).toHaveLength(1);
      expect(disconnect.mock.contexts).not.toContain(watching[0]);

      unmount();

      expect(disconnect.mock.contexts).toContain(watching[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ignores classes that are not the theme", async () => {
    const { result } = renderHook(() => useHostTheme());
    await act(async () => {
      document.documentElement.classList.add("font-loaded");
      await Promise.resolve();
    });
    expect(result.current).toBe("light");
  });

  it("does not read the OS colour scheme", () => {
    // A machine in dark mode, an app in light: the view must stay light.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { result } = renderHook(() => useHostTheme());
      expect(result.current).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});
