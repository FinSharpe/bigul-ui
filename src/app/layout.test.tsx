// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appCookieName } from "@/lib/auth/session";
import RootLayout from "./layout";

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  preload: vi.fn(),
}));

vi.mock("./globals.css", () => ({}));
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  preload: mocks.preload,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === appCookieName() && mocks.cookie !== undefined
        ? { name, value: mocks.cookie }
        : undefined,
  }),
}));

const render = async (cookie?: string) => {
  mocks.cookie = cookie;
  const html = await RootLayout({ children: null });
  return html.props as Record<string, unknown>;
};
const preloaded = () => mocks.preload.mock.calls.map(([href]) => href);

beforeEach(() => mocks.preload.mockClear());

describe("root layout", () => {
  it("renders the Super App dark, with DM Sans preloaded", async () => {
    const props = await render("superapp");
    expect(props["data-theme"]).toBe("superapp");
    expect(props.className).toBe("dark");
    expect(preloaded()).toEqual(["/fonts/app/DMSans-latin.woff2"]);
  });

  it.each([undefined, "bigul", "other", ""])(
    "adds no theme attribute or class for app cookie %j, and preloads Inter",
    async (cookie) => {
      const props = await render(cookie);
      expect(props["data-theme"]).toBeUndefined();
      expect(props.className).toBeUndefined();
      expect(props.lang).toBe("en");
      expect(preloaded()).toEqual([
        "/fonts/app/Inter-Regular.ttf",
        "/fonts/app/Inter-Medium.ttf",
        "/fonts/app/Inter-SemiBold.ttf",
      ]);
    },
  );
});
