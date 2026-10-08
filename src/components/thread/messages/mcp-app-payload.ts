/**
 * The interactive view a report tool attaches to its result message.
 *
 * WIRE CONTRACT: the agent backend writes this object on
 * `ToolMessage.additional_kwargs.mcp_app`. That key and the five field names
 * below are read exactly as written — renaming one on either side renders
 * nothing, with no error anywhere.
 */
export type McpAppPayload = {
  /** A complete, self-contained HTML document: the MCP-Apps guest view. */
  html: string;
  /** The data the view draws, handed over once the guest has initialised. */
  structuredContent: unknown;
  /** The tool that produced it, e.g. "render_stock_report". */
  toolName?: string;
  /** The view's `ui://` resource URI (informational). */
  resourceUri?: string;
  /** A title chosen by the tool. The report tools send none today. */
  title?: string;
};

const FALLBACK_HEADING = "Interactive view";

// Words a heading keeps in capitals ("render_mf_report" reads "MF Report").
const INITIALISMS = new Set(["mf", "etf", "ipo"]);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * The view attached to a tool message, or null when there is none to show.
 *
 * Null covers every payload that could not be drawn — no `mcp_app`, one that
 * is not an object, one without a non-empty `html` string — so callers can
 * treat "has a view" and "has a view that will render" as the same question,
 * and a malformed payload leaves the message looking the way it always did.
 */
export function getMcpAppPayload(
  message:
    | { additional_kwargs?: Record<string, unknown> | undefined }
    | null
    | undefined,
): McpAppPayload | null {
  const raw = message?.additional_kwargs?.mcp_app;
  if (!raw || typeof raw !== "object") return null;

  const { html, structuredContent, toolName, resourceUri, title } =
    raw as Record<string, unknown>;
  const viewHtml = nonEmptyString(html);
  if (!viewHtml) return null;

  return {
    html: viewHtml,
    structuredContent: structuredContent ?? null,
    toolName: nonEmptyString(toolName),
    resourceUri: nonEmptyString(resourceUri),
    title: nonEmptyString(title)?.trim(),
  };
}

/**
 * The ids of the tool calls that are drawn as a view, for a tool-call list to
 * leave out.
 *
 * A call counts when ANY of its results carries a view, not only the latest.
 * One call can be answered twice: stop a run while a report tool is working
 * and its real result is still stored, then the next message sent adds a
 * placeholder result for the same call. The view is on screen either way, so
 * the call's accordion must not be there as well.
 */
export function getViewCallIds(
  messages: ReadonlyArray<{
    type?: string;
    tool_call_id?: string;
    additional_kwargs?: Record<string, unknown> | undefined;
  }>,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.type !== "tool" || !message.tool_call_id) continue;
    if (getMcpAppPayload(message)) ids.add(message.tool_call_id);
  }
  return ids;
}

/**
 * The heading shown above a view: the tool's own title when it sends one,
 * otherwise a name read off the tool ("render_stock_report" -> "Stock Report").
 */
export function mcpAppHeading({
  title,
  toolName,
}: Pick<McpAppPayload, "title" | "toolName">): string {
  if (title) return title;
  const words = (toolName ?? "")
    .trim()
    .replace(/^render_/, "")
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return FALLBACK_HEADING;
  return words
    .map((word) =>
      INITIALISMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}
