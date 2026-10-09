import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { Message, ToolMessage } from "@langchain/langgraph-sdk";
import { ArtifactProvider } from "./artifact";
import { Thread } from "./index";

// How a report view sits in the real thread: <Thread> and <AssistantMessage>
// run as they are; only the stream (the messages), the thread list and the
// scroll container, which jsdom cannot lay out, are stand-ins.

const stream = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@/providers/Stream", () => ({
  useStreamContext: () => stream.current,
}));
vi.mock("@/providers/Thread", () => ({
  useThreads: () => ({ threads: [] }),
}));
vi.mock("@/hooks/use-chat-models", () => ({
  useChatModels: () => ({
    value: "auto",
    select: vi.fn(),
    options: [],
    unavailable: false,
    supportsImages: true,
    submissionOptions: () => ({}),
    cancelPendingSelection: vi.fn(),
  }),
}));
vi.mock("./history", () => ({ default: () => null }));
vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useStickToBottomContext: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isAtBottom: true,
    scrollToBottom: () => {},
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no matchMedia; <Thread> asks it whether the screen is large and
  // framer-motion (through the legacy listener API) whether to reduce motion.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

const VIEW_HTML =
  "<!doctype html><html><head><title>Stock Report</title></head><body></body></html>";
const VIEW = {
  html: VIEW_HTML,
  structuredContent: { kind: "stock_report", symbol: "INFY" },
  toolName: "render_stock_report",
  resourceUri: "ui://tradekit/stock-report-v3.html",
  title: null,
};

const question: Message = {
  type: "human",
  id: "human-1",
  content: "How is Infosys doing?",
};
// One AI message making an ordinary call and a report call side by side.
const calls: Message = {
  type: "ai",
  id: "ai-calls",
  content: "",
  tool_calls: [
    { id: "call_scan", name: "scan", args: { symbol: "INFY" } },
    {
      id: "call_report",
      name: "render_stock_report",
      args: { symbol: "INFY" },
    },
  ],
};
const scanResult: ToolMessage = {
  type: "tool",
  id: "tool-scan",
  tool_call_id: "call_scan",
  name: "scan",
  content: '{"hits": 3}',
};
const reportResult = (
  additional_kwargs?: Record<string, unknown>,
): ToolMessage => ({
  type: "tool",
  id: "tool-report",
  tool_call_id: "call_report",
  name: "render_stock_report",
  content: "Infosys summary for the model.",
  ...(additional_kwargs && { additional_kwargs }),
});
const reportWithView = reportResult({ mcp_app: VIEW });
const answer = (content = "Infosys looks steady."): Message => ({
  type: "ai",
  id: "ai-answer",
  content,
});

function showThread(
  messages: Message[],
  {
    hideToolCalls = false,
    isLoading = false,
    interrupt = undefined as unknown,
  } = {},
) {
  stream.current = {
    messages,
    values: { messages },
    isLoading,
    runStatus: isLoading ? "streaming" : "idle",
    runTerminations: {},
    error: undefined,
    interrupt,
    getMessagesMetadata: () => undefined,
    setBranch: vi.fn(),
    submit: vi.fn(),
    stop: vi.fn(),
    // The server the app is connected to. Where the stream context carries
    // it, the thread header shows its host.
    apiUrl: "http://localhost:2024",
  };
  return (
    <NuqsTestingAdapter
      searchParams={hideToolCalls ? "?hideToolCalls=true" : ""}
    >
      <ArtifactProvider>
        <Thread />
      </ArtifactProvider>
    </NuqsTestingAdapter>
  );
}

// What the generic tool UI puts on screen.
const SCAN = "Scan the market";
const REPORT_CALL = "Build the stock report";
const REPORT_RUNNING = "Building the stock report";
const accordions = () =>
  screen.queryAllByRole("button", { name: /expand tool call/i });
const view = () => screen.queryByTitle("Stock Report");
const follows = (later: Element, earlier: Element) =>
  !!(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
// Every state update hands the thread fresh message objects.
const fresh = (messages: Message[]): Message[] =>
  JSON.parse(JSON.stringify(messages));

beforeEach(() => {
  stream.current = undefined;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async () => new Response(new Uint8Array([0, 1, 2]))),
  );
});

describe("a report view in the thread", () => {
  it("keeps the model picker inside the leading composer slot", () => {
    render(showThread([]));
    const composer = screen.getByRole("form", { name: "Message composer" });
    const model = screen.getByRole("combobox", { name: "Select model" });
    const upload = screen.getByRole("button", { name: "Upload PDF or image" });
    const message = screen.getByRole("textbox", { name: "Your message" });
    expect(composer).toContainElement(model);
    expect(follows(upload, model)).toBe(true);
    expect(follows(message, model)).toBe(true);
    expect(
      screen.getAllByRole("combobox", { name: "Select model" }),
    ).toHaveLength(1);
  });

  const thread = [question, calls, scanResult, reportWithView, answer()];

  it("is drawn inline, where its tool result sits: after the calls, before the answer", async () => {
    render(showThread(thread));

    const frame = await screen.findByTitle("Stock Report");
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(follows(frame!, screen.getByText(SCAN))).toBe(true);
    expect(follows(screen.getByText("Infosys looks steady."), frame!)).toBe(
      true,
    );
  });

  it("keeps both originating calls inspectable beside the report", async () => {
    render(showThread(thread));

    expect(screen.getByText(SCAN)).toBeInTheDocument();
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(accordions()).toHaveLength(2);
    expect(
      screen.queryByText("Infosys summary for the model."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
  });

  it("is still drawn with hideToolCalls on, which hides only the tool detail", async () => {
    render(showThread(thread, { hideToolCalls: true }));

    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(screen.queryByText(SCAN)).not.toBeInTheDocument();
    expect(accordions()).toHaveLength(0);
    expect(screen.getByText("Infosys looks steady.")).toBeInTheDocument();
  });

  it("keeps a single report call inspectable without duplicating its result", async () => {
    const onlyReport: Message = {
      type: "ai",
      id: "ai-calls",
      content: "",
      tool_calls: [
        { id: "call_report", name: "render_stock_report", args: {} },
      ],
    };
    render(showThread([question, onlyReport, reportWithView, answer()]));

    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(accordions()).toHaveLength(1);
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
  });

  it("draws each of several reports, in order, each from its own result", async () => {
    const twoCalls: Message = {
      type: "ai",
      id: "ai-calls",
      content: "",
      tool_calls: [
        { id: "call_report", name: "render_stock_report", args: {} },
        { id: "call_fund", name: "render_mf_report", args: {} },
      ],
    };
    const fundResult: ToolMessage = {
      type: "tool",
      id: "tool-fund",
      tool_call_id: "call_fund",
      content: "Fund summary.",
      additional_kwargs: {
        mcp_app: { ...VIEW, toolName: "render_mf_report" },
      },
    };
    render(showThread([question, twoCalls, reportWithView, fundResult]));

    const stock = await screen.findByTitle("Stock Report");
    const fund = await screen.findByTitle("MF Report");
    expect(follows(fund, stock)).toBe(true);
    expect(accordions()).toHaveLength(2);
  });

  it("keeps a report beside its call before later sibling calls", async () => {
    const threeCalls: Message = {
      ...calls,
      tool_calls: [
        { id: "call_report", name: "render_stock_report", args: {} },
        { id: "call_scan", name: "scan", args: {} },
        { id: "call_quote", name: "get_stock_quote", args: {} },
      ],
    };
    render(
      showThread([question, threeCalls, reportWithView, scanResult, answer()]),
    );
    const reportCall = screen.getByRole("button", {
      name: `Expand tool call: ${REPORT_CALL}`,
    });
    expect(follows(await screen.findByTitle("Stock Report"), reportCall)).toBe(
      true,
    );
    expect(follows(screen.getByText(SCAN), view()!)).toBe(true);
    expect(accordions()).toHaveLength(3);
    expect(screen.queryByText("Retrieving data")).not.toBeInTheDocument();
  });

  it("is drawn for a result whose call the thread does not hold", async () => {
    // e.g. a thread restored without the calling message.
    const orphan = [question, reportWithView, answer()];

    const { unmount } = render(showThread(orphan));
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    unmount();

    render(showThread(orphan, { hideToolCalls: true }));
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
  });

  it("pairs calls streamed as Anthropic content blocks with their reports", async () => {
    const streamedCalls = {
      type: "ai",
      id: "ai-calls",
      content: [
        { type: "text", text: "Pulling the report." },
        { type: "tool_use", id: "call_scan", name: "scan", input: "{}" },
        {
          type: "tool_use",
          id: "call_report",
          name: "render_stock_report",
          input: '{"symbol": "INFY"}',
        },
      ],
      tool_calls: [],
    } as unknown as Message;
    render(showThread([question, streamedCalls, scanResult, reportWithView]));

    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(screen.getByText(SCAN)).toBeInTheDocument();
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(accordions()).toHaveLength(2);
  });

  describe("for a call that was answered twice", () => {
    // Stop the run while the report tool is working, then ask something
    // else: the server still stores the tool's real result, and the next
    // submit adds a placeholder result for the same call.
    const onlyReport: Message = {
      type: "ai",
      id: "ai-calls",
      content: "",
      tool_calls: [
        { id: "call_report", name: "render_stock_report", args: {} },
      ],
    };
    const placeholder: ToolMessage = {
      type: "tool",
      id: "do-not-render-9",
      tool_call_id: "call_report",
      name: "render_stock_report",
      content: "Successfully handled tool call.",
    };
    const followUp: Message[] = [
      { type: "human", id: "human-2", content: "And TCS?" },
      { type: "ai", id: "ai-answer-2", content: "TCS is flat." },
    ];

    it.each([
      [
        "the view first, the placeholder after it",
        [reportWithView, answer(), placeholder],
      ],
      [
        "the placeholder first, the view after it",
        [placeholder, reportWithView, answer()],
      ],
    ])(
      "shows the real view and inspectable call, ignoring a repair placeholder: %s",
      async (_l, results) => {
        render(showThread([question, onlyReport, ...results, ...followUp]));

        expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
        expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
        expect(accordions()).toHaveLength(1);
        expect(
          screen.queryByText("Successfully handled tool call."),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
      },
    );
  });
});

describe("a report view while the run is streaming", () => {
  it("preserves opened request and response details when its report completes", async () => {
    const onlyReport: Message = {
      ...calls,
      tool_calls: [
        {
          id: "call_report",
          name: "render_stock_report",
          args: { symbol: "INFY" },
        },
      ],
    };
    const { rerender } = render(
      showThread([question, onlyReport], { isLoading: true }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `Expand tool call: ${REPORT_RUNNING}`,
      }),
    );
    expect(screen.getByText("Request parameters")).toBeInTheDocument();
    rerender(
      showThread(fresh([question, onlyReport, reportWithView, answer()])),
    );
    expect(
      screen.getByRole("button", {
        name: `Collapse tool call: ${REPORT_CALL}`,
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Infosys summary for the model."),
    ).toBeInTheDocument();
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
  });

  it("settles the originating call and adds its report when the result lands", async () => {
    const { rerender } = render(
      showThread([question, calls, scanResult], { isLoading: true }),
    );
    expect(screen.getByText(REPORT_RUNNING)).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(view()).not.toBeInTheDocument();

    rerender(
      showThread([question, calls, scanResult, reportWithView], {
        isLoading: true,
      }),
    );
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
  });

  it("keeps the same frame, document untouched, as the answer streams in after it", async () => {
    const upTo = (text?: string) =>
      fresh([
        question,
        calls,
        scanResult,
        reportWithView,
        ...(text === undefined ? [] : [answer(text)]),
      ]);

    const { rerender } = render(showThread(upTo(), { isLoading: true }));
    const frame = (await screen.findByTitle(
      "Stock Report",
    )) as HTMLIFrameElement;
    await waitFor(() =>
      expect(frame.srcdoc).toContain("<title>Stock Report</title>"),
    );
    const loaded = frame.srcdoc;
    expect(loaded).toContain("<title>Stock Report</title>");

    for (const text of ["Infosys", "Infosys looks", "Infosys looks steady."]) {
      rerender(showThread(upTo(text), { isLoading: true }));
      expect(view()).toBe(frame);
      expect(frame.srcdoc).toBe(loaded);
    }

    // …and when the run ends and the thread is re-read from history.
    rerender(showThread(upTo("Infosys looks steady."), { isLoading: false }));
    expect(view()).toBe(frame);
    expect(frame.srcdoc).toBe(loaded);
    expect(screen.getByText("Infosys looks steady.")).toBeInTheDocument();
  });

  it("keeps the same frame when content-block calls become completed tool_calls", async () => {
    const streamedCalls = {
      type: "ai",
      id: "ai-calls",
      content: [
        { type: "tool_use", id: "call_scan", name: "scan", input: "{}" },
        {
          type: "tool_use",
          id: "call_report",
          name: "render_stock_report",
          input: '{"symbol": "INFY"}',
        },
      ],
      tool_calls: [],
    } as unknown as Message;

    const { rerender } = render(
      showThread(fresh([question, streamedCalls, scanResult, reportWithView]), {
        isLoading: true,
      }),
    );
    const frame = (await screen.findByTitle(
      "Stock Report",
    )) as HTMLIFrameElement;
    await waitFor(() =>
      expect(frame.srcdoc).toContain("<title>Stock Report</title>"),
    );
    const loaded = frame.srcdoc;
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    expect(accordions()).toHaveLength(2);

    rerender(
      showThread(
        fresh([question, calls, scanResult, reportWithView, answer()]),
      ),
    );
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    expect(view()).toBe(frame);
    expect(frame.srcdoc).toBe(loaded);
  });

  it("draws another message's report in a frame of its own, not the one already there", async () => {
    // Every stock report is the same document; only the data differs. A frame
    // kept on for a different message would keep the document it has loaded.
    const sameShape = (tag: string, symbol: string): Message[] => [
      { type: "human", id: `human-${tag}`, content: `How is ${symbol} doing?` },
      {
        type: "ai",
        id: `ai-${tag}`,
        content: "",
        tool_calls: [
          { id: `call-${tag}`, name: "render_stock_report", args: { symbol } },
        ],
      },
      {
        type: "tool",
        id: `tool-${tag}`,
        tool_call_id: `call-${tag}`,
        name: "render_stock_report",
        content: "summary",
        additional_kwargs: {
          mcp_app: {
            ...VIEW,
            structuredContent: { kind: "stock_report", symbol },
          },
        },
      },
      { type: "ai", id: `answer-${tag}`, content: `${symbol} looks steady.` },
    ];

    const { rerender } = render(showThread(sameShape("a", "INFY")));
    const first = await screen.findByTitle("Stock Report");
    expect(first).toBeInstanceOf(HTMLIFrameElement);

    // The same positions, the same document — a different message.
    rerender(showThread(sameShape("b", "TCS")));

    expect(await screen.findByTitle("Stock Report")).toBeInstanceOf(
      HTMLIFrameElement,
    );
    expect(view()).not.toBe(first);
  });
});

describe("tool messages without a usable view", () => {
  const ordinary = [question, calls, scanResult, reportResult(), answer()];

  it("render as before: every call in its accordion, no frame", async () => {
    render(showThread(ordinary));

    expect(screen.getByText(SCAN)).toBeInTheDocument();
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(accordions()).toHaveLength(2);
    expect(document.querySelector("iframe")).toBeNull();
    // Each result is inside its call's accordion, not a row of its own too.
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
  });

  it("are hidden as before with hideToolCalls on", async () => {
    render(showThread(ordinary, { hideToolCalls: true }));

    expect(accordions()).toHaveLength(0);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Infosys looks steady.")).toBeInTheDocument();
  });

  it("keeps an uncalled result inspectable by its friendly tool name", async () => {
    const orphan = [question, reportResult(), answer()];

    const { unmount } = render(showThread(orphan));
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    unmount();

    render(showThread(orphan, { hideToolCalls: true }));
    expect(screen.queryByText(REPORT_CALL)).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it.each([
    ["no html", { ...VIEW, html: undefined }],
    ["empty html", { ...VIEW, html: "" }],
    ["blank html", { ...VIEW, html: "   " }],
    ["html that is not a string", { ...VIEW, html: { doc: VIEW_HTML } }],
    ["a string payload", VIEW_HTML],
    ["an array payload", [VIEW]],
    ["a null payload", null],
  ])(
    "fall back to the generic tool UI on a malformed payload: %s",
    (_label, mcp_app) => {
      const thread = [
        question,
        calls,
        scanResult,
        reportResult({ mcp_app }),
        answer(),
      ];

      expect(() => render(showThread(thread))).not.toThrow();

      expect(accordions()).toHaveLength(2);
      expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
      expect(document.querySelector("iframe")).toBeNull();
      // As before means the accordion and nothing more: the result is not
      // also left in the thread as a stand-alone "Tool Result" block.
      expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    },
  );
});

describe("a pending interrupt and a report view", () => {
  const interrupt = { value: { question: "Approve the order?" } };
  const prompts = () =>
    screen.queryAllByRole("heading", { name: "Human Interrupt" });

  it("is drawn under a view standing in for an uncalled result, as it was under the generic one", async () => {
    // Before this feature: the result's own row, and the interrupt under it.
    const { unmount } = render(
      showThread([question, reportResult()], { interrupt }),
    );
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(prompts()).toHaveLength(1);
    unmount();

    render(showThread([question, reportWithView], { interrupt }));
    expect(prompts()).toHaveLength(1);
    expect(
      follows(prompts()[0], await screen.findByTitle("Stock Report")),
    ).toBe(true);
  });

  it("is drawn once, under the last message, when a view sits further up", async () => {
    render(showThread([question, reportWithView, answer()], { interrupt }));

    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(prompts()).toHaveLength(1);
    expect(
      follows(prompts()[0], screen.getByText("Infosys looks steady.")),
    ).toBe(true);
  });

  it("preserves an interrupt on the last paired result with and without a report", async () => {
    const { unmount } = render(
      showThread([question, calls, scanResult, reportResult()], { interrupt }),
    );
    expect(prompts()).toHaveLength(1);
    unmount();

    render(
      showThread([question, calls, scanResult, reportWithView], { interrupt }),
    );
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(prompts()).toHaveLength(1);
    expect(follows(prompts()[0], view()!)).toBe(true);
  });

  it("draws nothing extra under a last view when no interrupt is pending", async () => {
    render(showThread([question, reportWithView]));

    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(prompts()).toHaveLength(0);
  });
});
