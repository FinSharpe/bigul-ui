import { describe, expect, it } from "vitest";
import { parseTheme, themeFor } from "./platform";

describe("themeFor", () => {
  it.each([
    ["99", "superapp"],
    ["7", "bigul"],
    ["099", "bigul"],
    ["", "bigul"],
    [undefined, "bigul"],
    [null, "bigul"],
    ["toString", "bigul"],
    ["__proto__", "bigul"],
  ])("maps %j to %s", (platform, theme) => {
    expect(themeFor(platform)).toBe(theme);
  });
});

describe("parseTheme", () => {
  it.each([
    ["superapp", "superapp"],
    ["bigul", "bigul"],
    ["dark", "bigul"],
    [undefined, "bigul"],
  ])("reads %j as %s", (value, theme) => {
    expect(parseTheme(value)).toBe(theme);
  });
});
