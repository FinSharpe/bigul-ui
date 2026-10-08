import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
const SCAN = "Scanning the market"; // curated label for `scan`
const REPORT_CALL = "Render Stock Report"; // fallback label for the report tool
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
});

describe("a report view in the thread", () => {
  const thread = [question, calls, scanResult, reportWithView, answer()];

  it("is drawn inline, where its tool result sits: after the calls, before the answer", () => {
    render(showThread(thread));

    const frame = view();
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(follows(frame!, screen.getByText(SCAN))).toBe(true);
    expect(follows(screen.getByText("Infosys looks steady."), frame!)).toBe(
      true,
    );
  });

  it("replaces the generic call/result UI for that call only", () => {
    render(showThread(thread));

    // The ordinary call keeps its accordion…
    expect(screen.getByText(SCAN)).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    // …the report's call does not get one, and its result is not dumped.
    expect(screen.queryByText(REPORT_CALL)).not.toBeInTheDocument();
    expect(accordions()).toHaveLength(1);
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    expect(view()).toBeInTheDocument();
  });

  it("is still drawn with hideToolCalls on, which hides only the tool detail", () => {
    render(showThread(thread, { hideToolCalls: true }));

    expect(view()).toBeInTheDocument();
    expect(screen.queryByText(SCAN)).not.toBeInTheDocument();
    expect(accordions()).toHaveLength(0);
    expect(screen.getByText("Infosys looks steady.")).toBeInTheDocument();
  });

  it("leaves an AI message with nothing but a report call without any tool UI", () => {
    const onlyReport: Message = {
      type: "ai",
      id: "ai-calls",
      content: "",
      tool_calls: [
        { id: "call_report", name: "render_stock_report", args: {} },
      ],
    };
    render(showThread([question, onlyReport, reportWithView, answer()]));

    expect(view()).toBeInTheDocument();
    expect(accordions()).toHaveLength(0);
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
  });

  it("draws each of several reports, in order, each from its own result", () => {
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

    const stock = screen.getByTitle("Stock Report");
    const fund = screen.getByTitle("MF Report");
    expect(follows(fund, stock)).toBe(true);
    expect(accordions()).toHaveLength(0);
  });

  it("is drawn for a result whose call the thread does not hold", () => {
    // e.g. a thread restored without the calling message.
    const orphan = [question, reportWithView, answer()];

    const { unmount } = render(showThread(orphan));
    expect(view()).toBeInTheDocument();
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    unmount();

    render(showThread(orphan, { hideToolCalls: true }));
    expect(view()).toBeInTheDocument();
  });

  it("suppresses the accordion for a call an Anthropic model streamed as a content block", () => {
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

    expect(view()).toBeInTheDocument();
    expect(screen.getByText(SCAN)).toBeInTheDocument();
    expect(screen.queryByText(REPORT_CALL)).not.toBeInTheDocument();
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
      "shows the view and not the call's accordion as well: %s",
      (_l, results) => {
        render(showThread([question, onlyReport, ...results, ...followUp]));

        expect(view()).toBeInTheDocument();
        expect(screen.queryByText(REPORT_CALL)).not.toBeInTheDocument();
        expect(accordions()).toHaveLength(0);
        expect(
          screen.queryByText("Successfully handled tool call."),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
      },
    );
  });
});

describe("a report view while the run is streaming", () => {
  it("lists the call as running, then swaps it for the view when the result lands", () => {
    const { rerender } = render(
      showThread([question, calls, scanResult], { isLoading: true }),
    );
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(view()).not.toBeInTheDocument();

    rerender(
      showThread([question, calls, scanResult, reportWithView], {
        isLoading: true,
      }),
    );
    expect(screen.queryByText(REPORT_CALL)).not.toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(view()).toBeInTheDocument();
  });

  it("keeps the same frame, document untouched, as the answer streams in after it", () => {
    const upTo = (text?: string) =>
      fresh([
        question,
        calls,
        scanResult,
        reportWithView,
        ...(text === undefined ? [] : [answer(text)]),
      ]);

    const { rerender } = render(showThread(upTo(), { isLoading: true }));
    const frame = view() as HTMLIFrameElement;
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

  it("keeps the same frame when a row above it goes away", () => {
    // A model that streams its calls as content blocks fills in `tool_calls`
    // only when the message completes. Until then an ordinary result is a row
    // of its own above the view; afterwards it is folded into its call's
    // accordion, and every row below it moves up one place.
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
    const frame = view() as HTMLIFrameElement;
    const loaded = frame.srcdoc;
    expect(screen.getByText(/Tool Result/)).toBeInTheDocument();

    rerender(
      showThread(
        fresh([question, calls, scanResult, reportWithView, answer()]),
      ),
    );
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    expect(view()).toBe(frame);
    expect(frame.srcdoc).toBe(loaded);
  });

  it("draws another message's report in a frame of its own, not the one already there", () => {
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
    const first = view();
    expect(first).toBeInstanceOf(HTMLIFrameElement);

    // The same positions, the same document — a different message.
    rerender(showThread(sameShape("b", "TCS")));

    expect(view()).toBeInstanceOf(HTMLIFrameElement);
    expect(view()).not.toBe(first);
  });
});

describe("tool messages without a usable view", () => {
  const ordinary = [question, calls, scanResult, reportResult(), answer()];

  it("render as before: every call in its accordion, no frame", () => {
    render(showThread(ordinary));

    expect(screen.getByText(SCAN)).toBeInTheDocument();
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(accordions()).toHaveLength(2);
    expect(document.querySelector("iframe")).toBeNull();
    // Each result is inside its call's accordion, not a row of its own too.
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
  });

  it("are hidden as before with hideToolCalls on", () => {
    render(showThread(ordinary, { hideToolCalls: true }));

    expect(accordions()).toHaveLength(0);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Infosys looks steady.")).toBeInTheDocument();
  });

  it("render an uncalled result as the generic tool result, as before", () => {
    const orphan = [question, reportResult(), answer()];

    const { unmount } = render(showThread(orphan));
    expect(screen.getByText(/Tool Result/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    unmount();

    render(showThread(orphan, { hideToolCalls: true }));
    expect(screen.queryByText(/Tool Result/)).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it.each([
    ["no html", { ...VIEW, html: undefined }],
    ["empty html", { ...VIEW, html: "" }],
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

  it("is drawn under a view standing in for an uncalled result, as it was under the generic one", () => {
    // Before this feature: the result's own row, and the interrupt under it.
    const { unmount } = render(
      showThread([question, reportResult()], { interrupt }),
    );
    expect(screen.getByText(/Tool Result/)).toBeInTheDocument();
    expect(prompts()).toHaveLength(1);
    unmount();

    render(showThread([question, reportWithView], { interrupt }));
    expect(prompts()).toHaveLength(1);
    expect(follows(prompts()[0], view()!)).toBe(true);
  });

  it("is drawn once, under the last message, when a view sits further up", () => {
    render(showThread([question, reportWithView, answer()], { interrupt }));

    expect(view()).toBeInTheDocument();
    expect(prompts()).toHaveLength(1);
    expect(
      follows(prompts()[0], screen.getByText("Infosys looks steady.")),
    ).toBe(true);
  });

  it("is left as it was for a result whose call is in the thread", () => {
    // Folded into its call's accordion, an ordinary result has never carried
    // the interrupt; the view that replaces the accordion does not either.
    const { unmount } = render(
      showThread([question, calls, scanResult, reportResult()], { interrupt }),
    );
    expect(prompts()).toHaveLength(0);
    unmount();

    render(
      showThread([question, calls, scanResult, reportWithView], { interrupt }),
    );
    expect(view()).toBeInTheDocument();
    expect(prompts()).toHaveLength(0);
  });

  it("draws nothing extra under a last view when no interrupt is pending", () => {
    render(showThread([question, reportWithView]));

    expect(view()).toBeInTheDocument();
    expect(prompts()).toHaveLength(0);
  });
});
