import { useSyncExternalStore } from "react";

/** The two themes an MCP-Apps view can be told to draw in. */
export type HostTheme = "light" | "dark";

// Where the stamp may go inside a document: straight after its opening
// <head>, or else its opening <html>. Each pattern is anchored to the start
// and lets nothing but whitespace and a doctype come first, and the tag has
// to be written plainly — attributes as name, name=value or name="value" —
// so that it ends where a browser would end it. That is what makes the spot
// markup for certain: "<head" met any further in may be text (in a comment, a
// script string, an attribute value), and a stamp spliced in there is lost,
// or cuts the guest's own script in two.
const ATTRIBUTE = String.raw`\s+[^\s"'<>=/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=\x60]+))?`;
const opening = (tag: string) => String.raw`<${tag}(?:${ATTRIBUTE})*\s*>`;
const DOCTYPE = String.raw`^\s*(?:<!doctype[^>]*>\s*)?`;
const STAMP_AFTER = [
  new RegExp(`${DOCTYPE}(?:${opening("html")}\\s*)?${opening("head")}`, "i"),
  new RegExp(`${DOCTYPE}${opening("html")}`, "i"),
];

/**
 * Stamp the app's theme on an MCP-Apps guest document before its first paint:
 * `<html data-theme>`, which the report views key their colours on, and the
 * matching `color-scheme`.
 *
 * Without it a view paints in the *browser's* theme until the `ui/initialize`
 * reply carries `hostContext.theme` — so on a dark-mode OS, in a light app,
 * each new report would flash dark for a few frames before redrawing light.
 * The reply and `host-context-changed` still follow; this only makes the
 * first frame agree with them.
 *
 * Inserted just inside `<head>` (or `<html>`) when the document opens with
 * one, and otherwise at the very front, where nothing precedes it — in every
 * case ahead of any guest script. Anything but light/dark is dropped, so no
 * caller string ever reaches the document.
 */
export function stampGuestTheme(
  html: string,
  theme: HostTheme,
  headContent = "",
): string {
  if (theme !== "light" && theme !== "dark") return html;
  const stamp =
    `<meta name="color-scheme" content="${theme}">` +
    `<script>document.documentElement.setAttribute("data-theme","${theme}");</script>` +
    headContent;
  for (const tag of STAMP_AFTER) {
    const at = tag.exec(html)?.[0].length;
    if (at !== undefined) return html.slice(0, at) + stamp + html.slice(at);
  }
  return stamp + html;
}

// Dark mode in this app is class-based: every `dark:` utility and the `.dark`
// token block in globals.css hang off a `dark` class on <html>. Reading that
// class is therefore reading what the app is actually showing.
const isDark = () => document.documentElement.classList.contains("dark");

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const getSnapshot = (): HostTheme => (isDark() ? "dark" : "light");
const getServerSnapshot = (): HostTheme => "light";

/**
 * The theme the app around a view is showing, kept current.
 *
 * Deliberately not the OS setting: nothing here reads `prefers-color-scheme`,
 * so a view never goes dark on a dark-mode machine while the app around it is
 * light. Today nothing sets the `dark` class (no theme provider is mounted),
 * so this is always "light"; the day one is, views follow it with no change
 * here.
 */
export function useHostTheme(): HostTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
