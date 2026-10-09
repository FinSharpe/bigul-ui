import { afterEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { ToolMessage } from "@langchain/langgraph-sdk";
import { McpAppToolMessage } from "./mcp-app";

// jsdom gives an iframe a real contentWindow but never runs its srcDoc, so
// these tests play the guest: they dispatch the MessageEvents a view would
// post, with `source` set to the iframe's window, and read what the host
// posted back.

const HTML =
  '<!doctype html><html lang="en"><head><title>Stock Report</title></head><body><script>/* guest */</script></body></html>';
const STOCK = { kind: "stock_report", symbol: "INFY" };

function viewMessage(
  overrides: Record<string, unknown> = {},
  id = "tool-1",
): ToolMessage {
  return {
    type: "tool",
    id,
    tool_call_id: `call-${id}`,
    name: "render_stock_report",
    content: "Rendered the stock report.",
    additional_kwargs: {
      mcp_app: {
        html: HTML,
        structuredContent: STOCK,
        toolName: "render_stock_report",
        resourceUri: "ui://tradekit/stock-report-v3.html",
        title: null,
        ...overrides,
      },
    },
  };
}

const frame = (title = "Stock Report") =>
  screen.getByTitle(title) as HTMLIFrameElement;

/** Everything the host posts to this iframe from now on. */
function hostPosts(iframe: HTMLIFrameElement) {
  return vi
    .spyOn(iframe.contentWindow!, "postMessage")
    .mockImplementation(() => {});
}

/** The guest in `iframe` posts `data` to the host. */
function guestSends(
  iframe: HTMLIFrameElement,
  data: unknown,
  source: MessageEventSource | null = iframe.contentWindow,
) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

const initialize = (id: unknown = 1, params: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "ui/initialize",
  params,
});
const initialized = {
  jsonrpc: "2.0",
  method: "ui/notifications/initialized",
  params: {},
};
const sizeChanged = (params: unknown) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params,
});

/** The "message" listeners a spy on window.add/removeEventListener saw. */
const messageListeners = (spy: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}) =>
  spy.mock.calls
    .filter(([type]) => type === "message")
    .map(([, listener]) => listener);

/** The message again, as the fresh objects every stream update hands over. */
const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

async function switchAppTheme(theme: "light" | "dark") {
  await act(async () => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // MutationObserver delivers on a microtask.
    await Promise.resolve();
  });
}

afterEach(() => {
  // Unmount first: a mounted view would see the reset as a theme switch.
  cleanup();
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("<McpAppToolMessage /> frame", () => {
  it("loads the view through srcDoc in an iframe sandboxed to scripts only", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();

    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.hasAttribute("src")).toBe(false);
    // The served document, intact, with only the theme stamp added.
    expect(iframe.srcdoc).toContain("<title>Stock Report</title>");
    expect(iframe.srcdoc).toContain("<script>/* guest */</script>");
    expect(iframe.srcdoc.length).toBeGreaterThan(HTML.length);
  });

  it("is listening for the guest before it gives the iframe a document", () => {
    const addEventListener = window.addEventListener.bind(window);
    let atListen: { mounted: boolean; srcdoc: string | null } | undefined;
    vi.spyOn(window, "addEventListener").mockImplementation(((
      ...args: Parameters<typeof window.addEventListener>
    ) => {
      if (args[0] === "message") {
        const iframe = document.querySelector("iframe");
        atListen = {
          mounted: iframe !== null,
          srcdoc: iframe?.getAttribute("srcdoc") ?? null,
        };
      }
      return addEventListener(...args);
    }) as typeof window.addEventListener);

    render(<McpAppToolMessage message={viewMessage()} />);

    expect(atListen).toEqual({ mounted: true, srcdoc: null });
    expect(frame().getAttribute("srcdoc")).not.toBeNull();
  });

  it("names the accessible frame after the tool without a visible heading or outer frame", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(frame().title).toBe("Stock Report");
    expect(frame().parentElement).not.toHaveClass("border", "rounded-xl");
  });

  it("uses the tool's own title when it sends one", () => {
    render(
      <McpAppToolMessage message={viewMessage({ title: "Infosys Ltd." })} />,
    );
    expect(
      screen.queryByRole("heading", { name: "Infosys Ltd." }),
    ).not.toBeInTheDocument();
    expect(frame("Infosys Ltd.")).toBeInTheDocument();
  });

  it.each([
    ["html is missing", { html: undefined }],
    ["html is empty", { html: "" }],
    ["html is not a string", { html: 12 }],
  ])("renders nothing when %s", (_label, overrides) => {
    const { container } = render(
      <McpAppToolMessage message={viewMessage(overrides)} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when mcp_app is not an object, or absent", () => {
    for (const mcp_app of ["<html></html>", 3, null, undefined, [HTML]]) {
      const message = {
        ...viewMessage(),
        additional_kwargs: { mcp_app },
      } as ToolMessage;
      const { container, unmount } = render(
        <McpAppToolMessage message={message} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    const { container } = render(
      <McpAppToolMessage
        message={{ type: "tool", tool_call_id: "c", content: "plain" }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("<McpAppToolMessage /> host handshake", () => {
  it("answers ui/initialize with the host's identity, capabilities and theme", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, initialize(7, { protocolVersion: "2026-01-26" }));

    expect(posted).toHaveBeenCalledTimes(1);
    const [reply, targetOrigin] = posted.mock.calls[0];
    expect(targetOrigin).toBe("*");
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        appInfo: { name: "agent-chat-ui", version: "1.0.0" },
        hostInfo: { name: "agent-chat-ui", version: "1.0.0" },
        hostCapabilities: {},
        hostContext: { theme: "light" },
        protocolVersion: "2026-01-26",
      },
    });
  });

  it("echoes the guest's protocol version, and has one of its own to offer", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, initialize(1, { protocolVersion: "2099-01-01" }));
    guestSends(iframe, initialize("two"));
    guestSends(iframe, initialize(3, { protocolVersion: 5 }));
    guestSends(iframe, { jsonrpc: "2.0", id: 4, method: "ui/initialize" });

    const versions = posted.mock.calls.map(
      ([reply]) => (reply as any).result.protocolVersion,
    );
    expect(versions).toEqual([
      "2099-01-01",
      "2026-01-26",
      "2026-01-26",
      "2026-01-26",
    ]);
    expect((posted.mock.calls[1][0] as any).id).toBe("two");
  });

  it("does not answer an initialize that is not a request", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, { jsonrpc: "2.0", method: "ui/initialize" });
    guestSends(iframe, { jsonrpc: "2.0", id: null, method: "ui/initialize" });

    expect(posted).not.toHaveBeenCalled();
  });

  it("sends the tool result once the guest reports it has initialised", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, initialize());
    expect(posted).toHaveBeenCalledTimes(1); // the reply only — no data yet

    guestSends(iframe, initialized);
    expect(posted).toHaveBeenCalledTimes(2);
    expect(posted.mock.calls[1]).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: STOCK },
      },
      "*",
    ]);
  });

  it("sends null structured content rather than nothing when there is none", () => {
    render(
      <McpAppToolMessage
        message={viewMessage({ structuredContent: undefined })}
      />,
    );
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, initialized);

    expect((posted.mock.calls[0][0] as any).params).toEqual({
      structuredContent: null,
    });
  });

  it("sizes the frame to the height the guest reports", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    expect(iframe.style.height).toBe("520px");

    guestSends(iframe, sizeChanged({ height: 1234.2, width: 768 }));
    expect(iframe.style.height).toBe("1235px");

    guestSends(iframe, sizeChanged({ height: 300 }));
    expect(iframe.style.height).toBe("300px");
  });

  it("caps a runaway height", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();

    guestSends(iframe, sizeChanged({ height: 5_000_000 }));

    expect(iframe.style.height).toBe("20000px");
  });

  it.each([
    ["a fraction of a pixel", 0.0001],
    ["the smallest number there is", Number.MIN_VALUE],
    ["one pixel", 1],
    ["a few pixels", 2.5],
  ])(
    "does not collapse to a sliver when the guest reports %s",
    (_l, height) => {
      render(<McpAppToolMessage message={viewMessage()} />);
      const iframe = frame();

      guestSends(iframe, sizeChanged({ height }));

      expect(iframe.style.height).toBe("80px");
    },
  );

  it("leaves a height inside the band exactly as reported", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();

    for (const [height, shown] of [
      [80, "80px"],
      [80.2, "81px"],
      [20000, "20000px"],
    ] as const) {
      guestSends(iframe, sizeChanged({ height }));
      expect(iframe.style.height).toBe(shown);
    }
  });

  it.each([
    ["a numeric string", { height: "900" }],
    ["zero", { height: 0 }],
    ["a negative number", { height: -40 }],
    ["NaN", { height: NaN }],
    ["Infinity", { height: Infinity }],
    ["null", { height: null }],
    ["an object", { height: { px: 900 } }],
    ["no height at all", { width: 768 }],
    ["no params", undefined],
    ["params that are not an object", "900"],
  ])("keeps its height when the guest reports %s", (_label, params) => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    guestSends(iframe, sizeChanged({ height: 800 }));

    guestSends(iframe, sizeChanged(params));

    expect(iframe.style.height).toBe("800px");
  });

  it("tells a guest that asks for something this host does not offer", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, {
      jsonrpc: "2.0",
      id: 9,
      method: "ui/open-link",
      params: { url: "https://example.com" },
    });
    // A notification it does not know needs no answer.
    guestSends(iframe, { jsonrpc: "2.0", method: "ui/notifications/unknown" });

    expect(posted.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          id: 9,
          error: { code: -32601, message: "Method not found" },
        },
        "*",
      ],
    ]);
  });

  it.each([
    ["null", null],
    ["a string", "ui/initialize"],
    ["a number", 42],
    ["an array", [initialize()]],
    ["an object that is not JSON-RPC", { type: "ui/initialize", id: 1 }],
    ["JSON-RPC of another version", { ...initialize(), jsonrpc: "1.0" }],
    ["a message with no method", { jsonrpc: "2.0", id: 1, result: {} }],
    ["a method that is not a string", { jsonrpc: "2.0", id: 1, method: 7 }],
  ])("ignores %s without throwing", (_label, data) => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    expect(() => guestSends(iframe, data)).not.toThrow();

    expect(posted).not.toHaveBeenCalled();
    expect(iframe.style.height).toBe("520px");
  });

  it("ignores messages that do not come from its own iframe", () => {
    render(
      <>
        <McpAppToolMessage message={viewMessage()} />
        <iframe title="someone else" />
      </>,
    );
    const iframe = frame();
    const posted = hostPosts(iframe);
    const stranger = (screen.getByTitle("someone else") as HTMLIFrameElement)
      .contentWindow;

    for (const source of [window, stranger, null]) {
      guestSends(iframe, initialize(), source);
      guestSends(iframe, initialized, source);
      guestSends(iframe, sizeChanged({ height: 999 }), source);
    }

    expect(posted).not.toHaveBeenCalled();
    expect(iframe.style.height).toBe("520px");
  });

  it("keeps two views in one thread apart: each gets its own data and size", () => {
    const FUND = { kind: "mf_report", scheme: "Mid Cap Fund" };
    render(
      <>
        <McpAppToolMessage message={viewMessage({}, "tool-1")} />
        <McpAppToolMessage
          message={viewMessage(
            { structuredContent: FUND, toolName: "render_mf_report" },
            "tool-2",
          )}
        />
      </>,
    );
    const stock = frame("Stock Report");
    const fund = frame("MF Report");
    const toStock = hostPosts(stock);
    const toFund = hostPosts(fund);

    guestSends(fund, initialize(1));
    guestSends(fund, initialized);
    guestSends(fund, sizeChanged({ height: 640 }));

    expect(toStock).not.toHaveBeenCalled();
    expect(stock.style.height).toBe("520px");
    expect(fund.style.height).toBe("640px");
    expect((toFund.mock.calls[1][0] as any).params.structuredContent).toBe(
      FUND,
    );

    guestSends(stock, initialize(1));
    guestSends(stock, initialized);

    expect(toFund).toHaveBeenCalledTimes(2);
    expect((toStock.mock.calls[1][0] as any).params.structuredContent).toBe(
      STOCK,
    );
  });

  it("stops listening once it is unmounted", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<McpAppToolMessage message={viewMessage()} />);
    const guest = frame().contentWindow!;
    const posted = vi.spyOn(guest, "postMessage").mockImplementation(() => {});
    unmount();

    // The listener it put on the window has been taken off again. (Asked of
    // the window itself: once unmounted the frame is gone, so a listener left
    // behind would answer nothing and the check below could not tell.)
    expect(messageListeners(added)).toHaveLength(1);
    expect(messageListeners(removed)).toEqual(messageListeners(added));

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: initialize(), source: guest }),
      );
    });

    expect(posted).not.toHaveBeenCalled();
  });
});

describe("<McpAppToolMessage /> theme", () => {
  it("stamps the app's theme on the document and reports it on initialize", () => {
    document.documentElement.classList.add("dark");
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    expect(iframe.srcdoc).toContain(
      '<head><meta name="color-scheme" content="dark">' +
        '<script>document.documentElement.setAttribute("data-theme","dark");</script>',
    );

    guestSends(iframe, initialize());
    expect((posted.mock.calls[0][0] as any).result.hostContext).toEqual({
      theme: "dark",
    });
  });

  it("is light in a light app, stamped so the OS setting cannot show through", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    expect(frame().srcdoc).toContain(
      '<head><meta name="color-scheme" content="light">' +
        '<script>document.documentElement.setAttribute("data-theme","light");</script>',
    );
  });

  it("tells an initialised guest when the app switches theme, without reloading it", async () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const loaded = iframe.srcdoc;
    const posted = hostPosts(iframe);
    guestSends(iframe, initialize());
    guestSends(iframe, initialized);
    posted.mockClear();

    await switchAppTheme("dark");
    expect(posted.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { theme: "dark" },
        },
        "*",
      ],
    ]);

    await switchAppTheme("light");
    expect(posted).toHaveBeenCalledTimes(2);
    expect((posted.mock.calls[1][0] as any).params).toEqual({ theme: "light" });

    // A new srcDoc would reload the view and re-run the handshake.
    expect(frame()).toBe(iframe);
    expect(iframe.srcdoc).toBe(loaded);
  });

  it("sends a guest nothing before it has initialised; the reply carries the latest theme", async () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    await switchAppTheme("dark");
    expect(posted).not.toHaveBeenCalled();

    guestSends(iframe, initialize());
    expect((posted.mock.calls[0][0] as any).result.hostContext.theme).toBe(
      "dark",
    );

    // Already told on the reply: no redundant notification follows.
    guestSends(iframe, initialized);
    expect(posted.mock.calls.map(([m]) => (m as any).method)).toEqual([
      undefined,
      "ui/notifications/tool-result",
    ]);
  });

  it("catches up a guest whose theme changed between its initialize and initialized", async () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);

    guestSends(iframe, initialize());
    await switchAppTheme("dark");
    expect(posted).toHaveBeenCalledTimes(1); // still only the reply

    guestSends(iframe, initialized);
    expect(posted.mock.calls.slice(1).map(([m]) => m)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: STOCK },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark" },
      },
    ]);
  });
});

describe("<McpAppToolMessage /> stability", () => {
  it("does not reload the view when the same message arrives again as a new object", () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const loaded = iframe.srcdoc;
    guestSends(iframe, sizeChanged({ height: 900 }));

    // What a stream does on every state update: same message, fresh objects.
    for (let i = 0; i < 3; i++) {
      rerender(<McpAppToolMessage message={viewMessage()} />);
    }

    expect(frame()).toBe(iframe);
    expect(iframe.srcdoc).toBe(loaded);
    expect(iframe.style.height).toBe("900px");
  });

  it("leaves an initialised guest initialised when the message arrives again: a theme switch still reaches it", async () => {
    const { rerender } = render(
      <McpAppToolMessage message={fresh(viewMessage())} />,
    );
    const iframe = frame();
    const posted = hostPosts(iframe);
    guestSends(iframe, initialize());
    guestSends(iframe, initialized);
    posted.mockClear();

    for (let i = 0; i < 3; i++) {
      rerender(<McpAppToolMessage message={fresh(viewMessage())} />);
    }
    // Equal data is not news: nothing is sent, so nothing redraws.
    expect(posted).not.toHaveBeenCalled();

    await switchAppTheme("dark");
    expect(posted.mock.calls.map(([message]) => message)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark" },
      },
    ]);
  });

  it("listens once per document, not once per render", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { rerender } = render(
      <McpAppToolMessage message={fresh(viewMessage())} />,
    );
    expect(messageListeners(added)).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      rerender(<McpAppToolMessage message={fresh(viewMessage())} />);
    }
    expect(messageListeners(added)).toHaveLength(1);
    expect(messageListeners(removed)).toHaveLength(0);

    // A new document is a new subscription — and the old one is dropped.
    rerender(
      <McpAppToolMessage
        message={viewMessage({ html: HTML.replace("guest", "guest v2") })}
      />,
    );
    expect(messageListeners(added)).toHaveLength(2);
    expect(messageListeners(removed)).toEqual([messageListeners(added)[0]]);
  });

  it("tells an initialised guest when it is handed different data, and only then", () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const loaded = iframe.srcdoc;
    const posted = hostPosts(iframe);
    guestSends(iframe, initialize());
    guestSends(iframe, initialized);
    posted.mockClear();

    // Another report of the same kind: the same document, other data. Without
    // a word from the host the guest would go on showing the first one.
    const TCS = { kind: "stock_report", symbol: "TCS" };
    rerender(
      <McpAppToolMessage message={viewMessage({ structuredContent: TCS })} />,
    );
    expect(posted.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { structuredContent: TCS },
        },
        "*",
      ],
    ]);
    // Told, not reloaded.
    expect(frame()).toBe(iframe);
    expect(iframe.srcdoc).toBe(loaded);

    // The same data again — fresh objects, keys in another order — is not news.
    for (const again of [fresh(TCS), { symbol: "TCS", kind: "stock_report" }]) {
      rerender(
        <McpAppToolMessage
          message={viewMessage({ structuredContent: again })}
        />,
      );
    }
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("keeps changed data for the handshake of a guest that has yet to initialise", () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);
    guestSends(iframe, initialize());
    const TCS = { kind: "stock_report", symbol: "TCS" };

    rerender(
      <McpAppToolMessage message={viewMessage({ structuredContent: TCS })} />,
    );
    expect(posted).toHaveBeenCalledTimes(1); // the initialize reply, no data

    guestSends(iframe, initialized);
    expect(posted.mock.calls.slice(1).map(([message]) => message)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: TCS },
      },
    ]);
  });

  it("hands a re-initialising guest the latest data", () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);
    const fresher = { ...STOCK, as_of: "later" };

    rerender(
      <McpAppToolMessage
        message={viewMessage({ structuredContent: fresher })}
      />,
    );
    guestSends(iframe, initialized);

    expect((posted.mock.calls[0][0] as any).params.structuredContent).toBe(
      fresher,
    );
  });

  it("loads a new document, and starts a new handshake, when the HTML itself changes", async () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);
    guestSends(iframe, initialize());
    guestSends(iframe, initialized);
    posted.mockClear();

    const next = HTML.replace("/* guest */", "/* guest v2 */");
    rerender(<McpAppToolMessage message={viewMessage({ html: next })} />);

    expect(iframe.srcdoc).toContain("/* guest v2 */");
    // The new guest has not initialised: a theme switch waits for its handshake.
    await switchAppTheme("dark");
    expect(posted).not.toHaveBeenCalled();
  });

  it("answers the new document's guest once, not once per document the frame has held", () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    for (const version of ["v2", "v3"]) {
      rerender(
        <McpAppToolMessage
          message={viewMessage({ html: HTML.replace("guest", version) })}
        />,
      );
    }
    const posted = hostPosts(iframe);

    guestSends(iframe, initialize());
    guestSends(iframe, initialized);

    expect(
      posted.mock.calls.map(([message]) => (message as any).method ?? "reply"),
    ).toEqual(["reply", "ui/notifications/tool-result"]);
  });
});

describe("<McpAppToolMessage /> while the view is loading", () => {
  // A view runs no script until the stylesheets it links to have arrived, and
  // the report views link a web font: on a slow or filtered network the frame
  // is an empty box for as long as that takes.
  const loadingNotes = () => screen.queryAllByText("Loading");

  it("says so until the guest starts its handshake", () => {
    render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    hostPosts(iframe);
    expect(loadingNotes()).toHaveLength(1);

    // Not yet: another window asking, and this one saying anything but the
    // request a guest makes as its script starts.
    guestSends(iframe, initialize(), window);
    guestSends(iframe, { jsonrpc: "2.0", method: "ui/initialize" });
    guestSends(iframe, "ui/initialize");
    expect(loadingNotes()).toHaveLength(1);

    guestSends(iframe, initialize());
    expect(loadingNotes()).toHaveLength(0);
    // Removing the loading status leaves the report frame untouched.
    expect(frame()).toBe(iframe);
    expect(
      screen.queryByRole("heading", { name: "Stock Report" }),
    ).not.toBeInTheDocument();
  });

  it("says so until the document has loaded, when that document never starts a handshake", () => {
    render(
      <McpAppToolMessage message={viewMessage({ html: "<p>A note.</p>" })} />,
    );
    const iframe = frame();
    expect(loadingNotes()).toHaveLength(1);

    fireEvent.load(iframe);

    expect(loadingNotes()).toHaveLength(0);
  });

  it("does not take the empty frame's own load for the document's", () => {
    // A frame goes on the page empty and is handed its document a moment
    // later, and a browser fires `load` for the empty frame as well. Fired
    // here from a layout effect: once the frame is on the page, and before
    // the effect that gives it the document.
    let documentAtLoad: string | null | undefined;
    function LoadsWhileEmpty() {
      useLayoutEffect(() => {
        const iframe = document.querySelector("iframe")!;
        documentAtLoad = iframe.getAttribute("srcdoc");
        iframe.dispatchEvent(new Event("load"));
      }, []);
      return null;
    }

    render(
      <>
        <McpAppToolMessage message={viewMessage()} />
        <LoadsWhileEmpty />
      </>,
    );

    expect(documentAtLoad).toBeNull();
    expect(frame().getAttribute("srcdoc")).not.toBeNull();
    expect(loadingNotes()).toHaveLength(1);
  });

  it("says so again for a new document, and not for the same one handed over again", () => {
    const { rerender } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    hostPosts(iframe);
    guestSends(iframe, initialize());
    expect(loadingNotes()).toHaveLength(0);

    for (let i = 0; i < 3; i++) {
      rerender(<McpAppToolMessage message={fresh(viewMessage())} />);
    }
    expect(loadingNotes()).toHaveLength(0);

    rerender(
      <McpAppToolMessage
        message={viewMessage({ html: HTML.replace("guest", "guest v2") })}
      />,
    );
    expect(loadingNotes()).toHaveLength(1);

    guestSends(iframe, initialize(2));
    expect(loadingNotes()).toHaveLength(0);
  });

  it("is said by each view for itself", () => {
    render(
      <>
        <McpAppToolMessage message={viewMessage({}, "tool-1")} />
        <McpAppToolMessage
          message={viewMessage({ toolName: "render_mf_report" }, "tool-2")}
        />
      </>,
    );
    const stock = frame("Stock Report");
    hostPosts(stock);
    expect(loadingNotes()).toHaveLength(2);

    guestSends(stock, initialize());

    const [stillLoading] = loadingNotes();
    expect(loadingNotes()).toHaveLength(1);
    expect(frame("MF Report").parentElement).toContainElement(stillLoading);
    expect(stock.parentElement).not.toContainElement(stillLoading);
  });
});

describe("<McpAppToolMessage /> report recovery", () => {
  it("offers a reload when a report does not load and accepts the new handshake", () => {
    vi.useFakeTimers();
    try {
      render(<McpAppToolMessage message={viewMessage()} />);
      const first = frame();
      act(() => vi.advanceTimersByTime(15000));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The report did not open",
      );
      fireEvent.click(screen.getByRole("button", { name: "Reload report" }));
      const reloaded = frame();
      expect(reloaded).not.toBe(first);
      const posted = hostPosts(reloaded);
      guestSends(reloaded, JSON.stringify(initialize()));
      guestSends(reloaded, JSON.stringify(initialized));
      expect(posted).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "ui/notifications/tool-result",
          params: { structuredContent: STOCK },
        }),
        "*",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail a silent document that loaded successfully", () => {
    vi.useFakeTimers();
    try {
      render(
        <McpAppToolMessage
          message={viewMessage({ html: "<p>A static report.</p>" })}
        />,
      );
      fireEvent.load(frame());
      act(() => vi.advanceTimersByTime(15000));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Reload report" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("<McpAppToolMessage /> white-labelling", () => {
  it("ships no vendor name in the host's identity or its chrome", () => {
    const { container } = render(<McpAppToolMessage message={viewMessage()} />);
    const iframe = frame();
    const posted = hostPosts(iframe);
    guestSends(iframe, initialize());

    // Checked against what may be there rather than by searching for a
    // vendor's name: this file names none, not even to rule one out.
    const { appInfo, hostInfo } = (posted.mock.calls[0][0] as any).result;
    expect([appInfo.name, hostInfo.name]).toEqual([
      "agent-chat-ui",
      "agent-chat-ui",
    ]);
    // The chrome around the frame — not the served document inside it: the
    // words a person reads there, and the ones a screen reader is given.
    const chrome = container.cloneNode(true) as HTMLElement;
    chrome.querySelector("iframe")?.removeAttribute("srcdoc");
    expect(chrome.textContent).toBe("");
    expect(
      [...chrome.querySelectorAll("*")].flatMap((element) =>
        ["title", "aria-label", "alt"].flatMap(
          (name) => element.getAttribute(name) ?? [],
        ),
      ),
    ).toEqual(["Stock Report"]);
  });
});
