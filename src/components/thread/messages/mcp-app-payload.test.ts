import { describe, it, expect } from "vitest";
import {
  getMcpAppPayload,
  getViewCallIds,
  mcpAppHeading,
} from "./mcp-app-payload";

const HTML = "<!doctype html><html><head></head><body>view</body></html>";

// What the backend writes today: `title` is always null.
const asSent = {
  html: HTML,
  structuredContent: { kind: "stock_report", symbol: "INFY" },
  toolName: "render_stock_report",
  resourceUri: "ui://tradekit/stock-report-v3.html",
  title: null,
};

const toolMessage = (mcp_app: unknown) => ({
  type: "tool" as const,
  additional_kwargs: { mcp_app },
});

describe("getMcpAppPayload", () => {
  it("reads the five wire fields off additional_kwargs.mcp_app", () => {
    expect(getMcpAppPayload(toolMessage(asSent))).toEqual({
      html: HTML,
      structuredContent: { kind: "stock_report", symbol: "INFY" },
      toolName: "render_stock_report",
      resourceUri: "ui://tradekit/stock-report-v3.html",
      title: undefined,
    });
  });

  it("keeps a title the tool did send", () => {
    const payload = getMcpAppPayload(
      toolMessage({ ...asSent, title: "  Infosys at a glance " }),
    );
    expect(payload?.title).toBe("Infosys at a glance");
  });

  it("hands on the structured content untouched, and null when absent", () => {
    const data = { rows: [1, 2, 3] };
    expect(
      getMcpAppPayload(toolMessage({ html: HTML, structuredContent: data }))
        ?.structuredContent,
    ).toBe(data);
    expect(
      getMcpAppPayload(toolMessage({ html: HTML }))?.structuredContent,
    ).toBeNull();
  });

  it("drops optional fields of the wrong type instead of passing them on", () => {
    expect(
      getMcpAppPayload(
        toolMessage({ html: HTML, toolName: 42, resourceUri: {}, title: [] }),
      ),
    ).toEqual({
      html: HTML,
      structuredContent: null,
      toolName: undefined,
      resourceUri: undefined,
      title: undefined,
    });
  });

  it.each([
    ["no html", { structuredContent: {}, toolName: "render_stock_report" }],
    ["an empty html string", { ...asSent, html: "" }],
    ["a whitespace-only html string", { ...asSent, html: "  \n " }],
    ["html that is not a string", { ...asSent, html: { toString: "x" } }],
    ["a string", "<html></html>"],
    ["a number", 7],
    ["a boolean", true],
    ["an array", [asSent]],
    ["null", null],
    ["undefined", undefined],
  ])("is null for a payload that cannot be drawn: %s", (_label, mcp_app) => {
    expect(getMcpAppPayload(toolMessage(mcp_app))).toBeNull();
  });

  it("is null for a message with no view attached, or no message at all", () => {
    expect(getMcpAppPayload({})).toBeNull();
    expect(getMcpAppPayload({ additional_kwargs: {} })).toBeNull();
    expect(getMcpAppPayload({ additional_kwargs: undefined })).toBeNull();
    expect(getMcpAppPayload(undefined)).toBeNull();
    expect(getMcpAppPayload(null)).toBeNull();
  });

  it("does not throw when additional_kwargs is itself malformed", () => {
    for (const additional_kwargs of [null, "oops", 3, []]) {
      expect(getMcpAppPayload({ additional_kwargs } as never)).toBeNull();
    }
  });
});

describe("mcpAppHeading", () => {
  it("names the report after its tool", () => {
    expect(mcpAppHeading({ toolName: "render_stock_report" })).toBe(
      "Stock Report",
    );
    expect(mcpAppHeading({ toolName: "render_portfolio_report" })).toBe(
      "Portfolio Report",
    );
  });

  it("keeps initialisms in capitals", () => {
    expect(mcpAppHeading({ toolName: "render_mf_report" })).toBe("MF Report");
  });

  it("works for a tool that is not a render_* tool", () => {
    expect(mcpAppHeading({ toolName: "show_option_chain" })).toBe(
      "Show Option Chain",
    );
  });

  it("prefers the tool's own title", () => {
    expect(
      mcpAppHeading({ title: "Infosys", toolName: "render_stock_report" }),
    ).toBe("Infosys");
  });

  it("falls back to a neutral heading when there is nothing to name it by", () => {
    expect(mcpAppHeading({})).toBe("Interactive view");
    expect(mcpAppHeading({ toolName: "render_" })).toBe("Interactive view");
    expect(mcpAppHeading({ toolName: "   " })).toBe("Interactive view");
  });
});

describe("getViewCallIds", () => {
  const result = (tool_call_id: string, mcp_app?: unknown) => ({
    type: "tool" as const,
    tool_call_id,
    content: "result",
    ...(mcp_app !== undefined && { additional_kwargs: { mcp_app } }),
  });

  it("names the calls whose result carries a usable view, and no others", () => {
    const ids = getViewCallIds([
      { type: "human" },
      { type: "ai" },
      result("call_scan"),
      result("call_report", asSent),
      result("call_broken", { ...asSent, html: "" }),
      result("call_fund", { ...asSent, toolName: "render_mf_report" }),
    ]);
    expect([...ids]).toEqual(["call_report", "call_fund"]);
  });

  it("counts a call answered twice when either result carries the view", () => {
    // Stop a run while the report tool is working: its real result is still
    // stored, and the next message sent adds a placeholder for the same call.
    const placeholder = result("call_report");
    expect([
      ...getViewCallIds([result("call_report", asSent), placeholder]),
    ]).toEqual(["call_report"]);
    expect([
      ...getViewCallIds([placeholder, result("call_report", asSent)]),
    ]).toEqual(["call_report"]);
  });

  it("ignores a view on anything that is not the result of a call", () => {
    const view = { additional_kwargs: { mcp_app: asSent } };
    expect(
      getViewCallIds([
        { type: "ai", ...view },
        { type: "tool", ...view },
        { type: "tool", tool_call_id: "", ...view },
      ]).size,
    ).toBe(0);
    expect(getViewCallIds([]).size).toBe(0);
  });
});
