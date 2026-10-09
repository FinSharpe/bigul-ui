"use client";

// Draws the interactive view a report tool attached to its result message
// (see mcp-app-payload.ts), inline in the thread.
//
// The view is a self-contained HTML document written as an MCP-Apps *guest*.
// It runs in a sandboxed iframe and this component plays the *host* side of
// its JSON-RPC-over-postMessage handshake:
//
//   1. guest -> host  request  "ui/initialize"            (host MUST reply)
//   2. guest -> host  notify   "ui/notifications/initialized"
//   3. host  -> guest notify   "ui/notifications/tool-result" { structuredContent }
//   4. guest -> host  notify   "ui/notifications/size-changed" { height, width }
//   5. host  -> guest notify   "ui/notifications/host-context-changed" { theme }
//
// Nothing here knows about a particular tool: any tool whose result carries a
// view is drawn the same way.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Message, ToolMessage } from "@langchain/langgraph-sdk";
import { isEqual } from "lodash";
import { LoaderCircle } from "lucide-react";
import {
  getMcpAppPayload,
  mcpAppHeading,
  type McpAppPayload,
} from "./mcp-app-payload";
import { stampGuestTheme, useHostTheme, type HostTheme } from "./mcp-app-theme";
import { additionalKwargs } from "./tool-activity";

export type McpApp = McpAppPayload;
export function getMcpApp(message: Message): McpApp | undefined {
  return (
    getMcpAppPayload({ additional_kwargs: additionalKwargs(message) }) ??
    undefined
  );
}

/** Keep reports self-contained, with the same document policy as Mobile. */
export function wrapGuestHtml(html: string, theme: HostTheme, fontCss = "") {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'">`;
  const navigation = `<script>document.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('a'))e.preventDefault()},true);</script>`;
  // Embedded reports use the chat column's gutters, rather than a second
  // document inset. Only the outer shell changes; cards and tables keep theirs.
  const layout =
    "<style data-chat-report-layout>html,body{margin:0!important;padding:0!important}body>.wrap{margin:0!important;padding:0!important}</style>";
  return stampGuestTheme(html, theme, policy + fontCss + navigation + layout);
}

let fontPromise: Promise<string> | undefined;
function reportFontCss() {
  return (fontPromise ??= Promise.all(
    [400, 500, 600].map(async (weight) => {
      const response = await fetch(
        `/fonts/report/Inter-${weight}.subset.woff2`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (!response.ok) throw new Error("Font unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${btoa(binary)}) format('woff2');}`;
    }),
  )
    .then((fonts) => `<style>${fonts.join("")}</style>`)
    .catch(() => {
      fontPromise = undefined;
      return "";
    }));
}

export function McpAppReport({ app }: { app: McpApp }) {
  const [fontCss, setFontCss] = useState<string>();
  useEffect(() => {
    let active = true;
    reportFontCss().then((css) => {
      if (active) setFontCss(css);
    });
    return () => {
      active = false;
    };
  }, []);
  return fontCss === undefined ? (
    <p
      role="status"
      className="text-muted-foreground text-xs"
    >
      Opening report…
    </p>
  ) : (
    <McpAppFrame
      html={app.html}
      structuredContent={app.structuredContent}
      heading={mcpAppHeading(app)}
      fontCss={fontCss}
    />
  );
}

// How this host names itself to a guest. `hostInfo` is the MCP-Apps name for
// the field; `appInfo` is what the first hosts of these views sent. Guests
// read neither today, so both are sent.
const HOST_INFO = { name: "agent-chat-ui", version: "1.0.0" };
const PROTOCOL_VERSION = "2026-01-26";
const METHOD_NOT_FOUND = -32601;

// The frame's height until the guest reports its own, and the band a reported
// height is held to — a view is untrusted, and a single absurd number should
// be able neither to collapse its card to a sliver nor to turn the thread
// into a mile of blank scroll.
const DEFAULT_HEIGHT = 520;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 20000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function McpAppFrame({
  html,
  structuredContent,
  heading,
  fontCss = "",
}: {
  html: string;
  structuredContent: unknown;
  heading: string;
  fontCss?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  // Set inside the effect, AFTER the message listener is attached, so the
  // guest's one-shot "ui/initialize" request can never arrive unheard.
  const [srcDoc, setSrcDoc] = useState<string>();
  // The document whose guest has shown a sign of life. Until the one in the
  // frame has, the frame is an empty box, and that can last: a document runs
  // no script while a stylesheet it links to is still on its way, and the
  // report views link a web font. A status says it is loading meanwhile.
  // Kept as the document, not as a flag, so that a new document starts out
  // loading without having to be told.
  const [liveHtml, setLiveHtml] = useState<string>();
  const loading = liveHtml !== html;

  // The listener below is attached once per document; it reads the latest
  // data and theme through refs instead of re-subscribing when they change.
  // The refs are brought up to date in a layout effect, not while rendering:
  // a render can be thrown away, and a ref written in one would be left
  // holding what was never shown (the react-hooks/refs lint rule). It runs
  // in the same commit, ahead of the effects below and of any guest message
  // handled after it.
  const dataRef = useRef(structuredContent);
  const theme = useHostTheme();
  const themeRef = useRef(theme);
  useLayoutEffect(() => {
    dataRef.current = structuredContent;
    themeRef.current = theme;
  });

  // Whether the guest has initialised, and the theme and data it was last
  // told. A theme switch before it is ready rides on the initialize reply
  // instead.
  const readyRef = useRef(false);
  const liveDocumentRef = useRef(false);
  const guestThemeRef = useRef<HostTheme | null>(null);
  const guestDataRef = useRef<unknown>(undefined);

  const post = useCallback((message: unknown) => {
    // "*": a sandboxed guest has an opaque origin, so there is none to name.
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  // (3) hand the guest the data it is to draw.
  const sendData = useCallback(() => {
    guestDataRef.current = dataRef.current;
    post({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: dataRef.current ?? null },
    });
  }, [post]);

  // (5) tell an initialised guest about a theme it has not been told yet.
  const syncTheme = useCallback(() => {
    if (!readyRef.current || guestThemeRef.current === themeRef.current) return;
    guestThemeRef.current = themeRef.current;
    post({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: themeRef.current },
    });
  }, [post]);

  useEffect(() => {
    syncTheme();
  }, [theme, syncTheme]);

  useEffect(() => {
    // A new document loads and initialises afresh.
    readyRef.current = false;
    liveDocumentRef.current = false;
    guestThemeRef.current = null;

    const onMessage = (event: MessageEvent) => {
      // Only this widget's own iframe — several can share one thread.
      const guest = iframeRef.current?.contentWindow;
      if (!guest || event.source !== guest) return;
      let message: unknown = event.data;
      if (typeof message === "string") {
        try {
          message = JSON.parse(message);
        } catch {
          return;
        }
      }
      if (
        !isRecord(message) ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string"
      ) {
        return;
      }
      const params = isRecord(message.params) ? message.params : {};
      const isRequest = message.id !== undefined && message.id !== null;

      switch (message.method) {
        // (1) reply, so the guest's promise resolves and it carries on.
        case "ui/initialize":
          if (!isRequest) return;
          setLiveHtml(html);
          liveDocumentRef.current = true;
          setFailed(false);
          guestThemeRef.current = themeRef.current;
          post({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              appInfo: HOST_INFO,
              hostInfo: HOST_INFO,
              hostCapabilities: {},
              hostContext: { theme: themeRef.current },
              protocolVersion:
                typeof params.protocolVersion === "string"
                  ? params.protocolVersion
                  : PROTOCOL_VERSION,
            },
          });
          return;
        // (2) the guest is ready -> (3) hand it the data.
        case "ui/notifications/initialized":
          setLiveHtml(html);
          liveDocumentRef.current = true;
          setFailed(false);
          readyRef.current = true;
          sendData();
          syncTheme();
          return;
        // (4) grow the frame to the view's natural height.
        case "ui/notifications/size-changed": {
          const reported = params.height;
          if (
            typeof reported === "number" &&
            Number.isFinite(reported) &&
            reported > 0
          ) {
            setHeight(
              Math.max(MIN_HEIGHT, Math.min(Math.ceil(reported), MAX_HEIGHT)),
            );
          }
          return;
        }
        default:
          // This host offers no other capability. Say so to a request, so the
          // guest is not left waiting on an answer that will never come.
          if (isRequest) {
            post({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: METHOD_NOT_FOUND, message: "Method not found" },
            });
          }
      }
    };

    window.addEventListener("message", onMessage);
    // The listener is live — now load the guest, already in the app's theme.
    setSrcDoc(wrapGuestHtml(html, themeRef.current, fontCss));
    const timeout = setTimeout(() => {
      if (!liveDocumentRef.current) setFailed(true);
    }, 15000);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [html, fontCss, generation, post, sendData, syncTheme]);

  // A frame draws the data it is given, so one that is given different data
  // says so to its guest: every report of a kind is the same document, and
  // without this a frame handed another report's data would go on showing
  // the old one. Compared by value — each stream update brings a fresh but
  // equal object, and re-sending that would redraw the view (and reset its
  // tabs) for nothing. Declared after the effect above, so that a new
  // document is seen as not yet initialised and is left to its own handshake.
  useEffect(() => {
    if (readyRef.current && !isEqual(guestDataRef.current, structuredContent)) {
      sendData();
    }
  }, [structuredContent, sendData]);

  return (
    <div className="w-full min-w-0">
      {loading && !failed && (
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-1.5 py-2 text-xs"
        >
          <LoaderCircle
            aria-hidden
            className="size-3 animate-spin"
          />
          Loading
        </p>
      )}
      {failed && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 py-2 text-xs">
          <p role="alert">
            The report did not open. You can reload it; the conversation is
            saved.
          </p>
          <button
            type="button"
            className="text-primary underline underline-offset-2"
            onClick={() => {
              setFailed(false);
              setLiveHtml(undefined);
              setGeneration((value) => value + 1);
            }}
          >
            Reload report
          </button>
        </div>
      )}
      <iframe
        key={generation}
        ref={iframeRef}
        srcDoc={srcDoc}
        // Having loaded is the other sign of life, and the only one from a
        // document that never says a word. Not listened for until there is a
        // document: the empty frame this starts as "loads" too.
        onLoad={
          srcDoc === undefined
            ? undefined
            : () => {
                liveDocumentRef.current = true;
                setLiveHtml(html);
                setFailed(false);
              }
        }
        // Scripts only. Without allow-same-origin the view runs at an opaque
        // origin: postMessage and canvas work; cookies, storage and this
        // page's DOM are out of its reach.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={heading}
        className="block w-full border-0"
        style={{ height }}
      />
    </div>
  );
}

/**
 * A tool message drawn as the interactive view it carries, or nothing when it
 * carries none. Shown whatever "hide tool calls" says: that setting hides the
 * raw call/result detail, and a report is the answer, not the detail.
 *
 * Memoised on the message object: the stream replaces only the message that
 * is still arriving, so tokens streaming into a later answer do not re-render
 * a finished report. (They could never reload it — the frame's document only
 * changes with the HTML itself — but this keeps them from costing anything.)
 */
export const McpAppToolMessage = memo(function McpAppToolMessage({
  message,
}: {
  message: ToolMessage;
}) {
  const payload = getMcpAppPayload(message);
  if (!payload) return null;
  return (
    <McpAppFrame
      html={payload.html}
      structuredContent={payload.structuredContent}
      heading={mcpAppHeading(payload)}
    />
  );
});
