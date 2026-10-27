import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "./page";

const mocks = vi.hoisted(() => ({
  session: null as { clientCode: string } | null,
  embedded: false,
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getServerSession: async () => mocks.session,
  isEmbedded: async () => mocks.embedded,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

beforeEach(() => {
  mocks.session = null;
  mocks.embedded = false;
  mocks.redirect.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderLogin(params: Record<string, string> = {}) {
  render(await LoginPage({ searchParams: Promise.resolve(params) }));
}

describe("login page", () => {
  it("offers Bigul sign-in that returns to the requested page", async () => {
    await renderLogin({ next: "/?threadId=abc" });
    expect(
      screen.getByRole("heading", { name: "Mayra AI" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sign in with your Bigul account to continue."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Sign in with Bigul" }),
    ).toHaveAttribute(
      "href",
      `/auth/login?next=${encodeURIComponent("/?threadId=abc")}`,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops an off-site destination", async () => {
    await renderLogin({ next: "//evil.example" });
    expect(
      screen.getByRole("link", { name: "Sign in with Bigul" }),
    ).toHaveAttribute("href", "/auth/login?next=%2F");
  });

  it.each([
    ["denied", /cancelled/],
    ["state", /timed out/],
    ["verify", /couldn't confirm your Bigul account/],
    ["unavailable", /couldn't reach Bigul/],
    ["config", /isn't available right now/],
  ])("explains the %s error in plain words", async (error, message) => {
    await renderLogin({ error });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it.each(["unknown", "toString", "__proto__"])(
    "ignores the unrecognised error %j",
    async (error) => {
      await renderLogin({ error });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("sends a signed-in client on to their destination", async () => {
    mocks.session = { clientCode: "Y1" };
    await expect(renderLogin({ next: "/?threadId=abc" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/?threadId=abc");
  });

  it.each([
    "/.//evil.com",
    "/%2e//evil.com",
    "/..//evil.com",
    "/a/..//evil.com/x",
  ])(
    "sends a signed-in client home, not off-site, for next=%j",
    async (next) => {
      mocks.session = { clientCode: "Y1" };
      await expect(renderLogin({ next })).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.redirect).toHaveBeenCalledWith("/");
    },
  );

  it("shows development sign-in only under next dev with AUTH_DEV_LOGIN=true", async () => {
    vi.stubEnv("AUTH_DEV_LOGIN", "true");
    await renderLogin();
    expect(screen.queryByLabelText("Client code")).not.toBeInTheDocument();

    vi.stubEnv("NODE_ENV", "development");
    await renderLogin({ next: "/?a=1" });
    const input = screen.getByLabelText("Client code");
    const form = input.closest("form")!;
    expect(form).toHaveAttribute("action", "/auth/dev-login");
    expect(form).toHaveAttribute("method", "get");
    expect(form.querySelector('input[name="next"]')).toHaveValue("/?a=1");
  });

  describe("inside the Bigul app", () => {
    beforeEach(() => {
      mocks.embedded = true;
    });

    it("never shows the sign-in button: a signed-out client goes to the app's re-sign-in page", async () => {
      await expect(renderLogin({ next: "/?threadId=abc" })).rejects.toThrow(
        "NEXT_REDIRECT",
      );
      expect(mocks.redirect).toHaveBeenCalledWith(
        `/auth/mobile/expired?next=${encodeURIComponent("/?threadId=abc")}`,
      );
      expect(
        screen.queryByRole("link", { name: "Sign in with Bigul" }),
      ).not.toBeInTheDocument();
    });

    it.each(["denied", "state", "verify", "unavailable", "config"])(
      "sends the %s error to the mobile error page",
      async (error) => {
        await expect(renderLogin({ error })).rejects.toThrow("NEXT_REDIRECT");
        expect(mocks.redirect).toHaveBeenCalledWith(
          `/auth/mobile/error?code=${error}`,
        );
      },
    );

    it("treats an unrecognised error as an ended session", async () => {
      await expect(renderLogin({ error: "__proto__" })).rejects.toThrow(
        "NEXT_REDIRECT",
      );
      expect(mocks.redirect).toHaveBeenCalledWith(
        "/auth/mobile/expired?next=%2F",
      );
    });

    it("still sends a signed-in client straight on", async () => {
      mocks.session = { clientCode: "Y1" };
      await expect(renderLogin({ next: "/?threadId=abc" })).rejects.toThrow(
        "NEXT_REDIRECT",
      );
      expect(mocks.redirect).toHaveBeenCalledWith("/?threadId=abc");
    });
  });
});
