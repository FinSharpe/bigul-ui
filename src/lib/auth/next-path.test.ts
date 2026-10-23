import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/?threadId=abc", "/?threadId=abc"],
    [
      "/?threadId=abc&chatHistoryOpen=true",
      "/?threadId=abc&chatHistoryOpen=true",
    ],
    ["/reports/a%20b?x=1#top", "/reports/a%20b?x=1#top"],
    ["/a/../b", "/b"],
  ])("keeps the same-origin path %j", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });

  it.each([
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "/path\\with\\backslashes",
    "https://evil.example/",
    "http:/evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/\tevil",
    "/\n/evil.example",
    "",
    "/".padEnd(2049, "a"),
  ])("rejects %j", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it.each([
    "/.//evil.com",
    "/%2e//evil.com",
    "/%2E%2E//evil.com",
    "/..//evil.com",
    "/a/..//evil.com/x",
    "/a/./..//evil.com?x=1#y",
  ])("rejects %j, which normalises to a protocol-relative URL", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it("keeps a double slash later in the path", () => {
    expect(safeNextPath("/a//b")).toBe("/a//b");
  });

  it.each([
    "/login",
    "/login?next=/",
    "/auth/login",
    "/Auth/callback",
    "/api/threads",
    "/%61uth/login",
  ])("sends %j home instead of into a sign-in loop", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it("ignores non-strings", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(["/a"])).toBe("/");
  });
});
