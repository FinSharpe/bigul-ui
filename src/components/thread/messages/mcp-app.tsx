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
import type { ToolMessage } from "@langchain/langgraph-sdk";
import { isEqual } from "lodash";
import { ChartColumn, LoaderCircle } from "lucide-react";
import { getMcpAppPayload, mcpAppHeading } from "./mcp-app-payload";
import { stampGuestTheme, useHostTheme, type HostTheme } from "./mcp-app-theme";

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
}: {
  html: string;
  structuredContent: unknown;
  heading: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  // Set inside the effect, AFTER the message listener is attached, so the
  // guest's one-shot "ui/initialize" request can never arrive unheard.
  const [srcDoc, setSrcDoc] = useState<string>();
  // The document whose guest has shown a sign of life. Until the one in the
  // frame has, the frame is an empty box, and that can last: a document runs
  // no script while a stylesheet it links to is still on its way, and the
  // report views link a web font. The card says it is loading meanwhile.
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
    guestThemeRef.current = null;

    const onMessage = (event: MessageEvent) => {
      // Only this widget's own iframe — several can share one thread.
      const guest = iframeRef.current?.contentWindow;
      if (!guest || event.source !== guest) return;
      const message: unknown = event.data;
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
    setSrcDoc(stampGuestTheme(html, themeRef.current));
    return () => window.removeEventListener("message", onMessage);
  }, [html, post, sendData, syncTheme]);

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
    <div className="bg-card text-card-foreground w-full overflow-hidden rounded-xl border shadow-xs">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <ChartColumn
          aria-hidden
          className="text-muted-foreground size-4 shrink-0"
        />
        <h3 className="truncate text-sm font-medium">{heading}</h3>
        {loading && (
          <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-xs">
            <LoaderCircle
              aria-hidden
              className="size-3 animate-spin"
            />
            Loading
          </span>
        )}
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        // Having loaded is the other sign of life, and the only one from a
        // document that never says a word. Not listened for until there is a
        // document: the empty frame this starts as "loads" too.
        onLoad={srcDoc === undefined ? undefined : () => setLiveHtml(html)}
        // Scripts only. Without allow-same-origin the view runs at an opaque
        // origin: postMessage and canvas work; cookies, storage and this
        // page's DOM are out of its reach.
        sandbox="allow-scripts"
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
