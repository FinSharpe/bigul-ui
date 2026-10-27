import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearChatStorage } from "@/lib/chat-storage";
import { SessionProvider } from "@/providers/Session";
import { SignOutButton } from "./sign-out-button";

beforeEach(() => {
  // The icon variant's Radix tooltip measures itself.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function seedStorage() {
  window.localStorage.setItem("lg:chat:apiKey", "k");
  window.localStorage.setItem("lg:chat:selectedModel", "m");
  window.localStorage.setItem("other:setting", "keep");
  window.sessionStorage.setItem("lg:session:abc:lg:stream:t1", "run-1");
  window.sessionStorage.setItem("unrelated", "keep");
}

describe("clearChatStorage", () => {
  it("removes only this app's lg: keys from both storages", () => {
    seedStorage();
    clearChatStorage();
    expect(Object.keys(window.localStorage)).toEqual(["other:setting"]);
    expect(Object.keys(window.sessionStorage)).toEqual(["unrelated"]);
  });
});

describe("SignOutButton", () => {
  it.each(["icon", "text"] as const)(
    "%s variant posts to /auth/logout after clearing chat storage",
    async (variant) => {
      const user = userEvent.setup();
      seedStorage();
      render(<SignOutButton variant={variant} />);

      const button = screen.getByRole("button", { name: "Sign out" });
      const form = button.closest("form")!;
      expect(form).toHaveAttribute("method", "post");
      expect(form).toHaveAttribute("action", "/auth/logout");
      expect(button).toHaveAttribute("type", "submit");

      let submitted = false;
      // jsdom cannot navigate; stop the native submission after React's handler.
      form.addEventListener("submit", (event) => {
        submitted = true;
        event.preventDefault();
      });
      await user.click(button);

      expect(submitted).toBe(true);
      expect(window.localStorage.getItem("lg:chat:apiKey")).toBeNull();
      expect(window.localStorage.getItem("other:setting")).toBe("keep");
      expect(
        window.sessionStorage.getItem("lg:session:abc:lg:stream:t1"),
      ).toBeNull();
    },
  );
});

describe("SignOutButton inside the Bigul app", () => {
  it.each(["icon", "text"] as const)(
    "%s variant is hidden: the app owns sign-out",
    (variant) => {
      render(
        <SessionProvider
          clientCode="Y1"
          embedded
        >
          <SignOutButton variant={variant} />
        </SessionProvider>,
      );
      expect(
        screen.queryByRole("button", { name: "Sign out" }),
      ).not.toBeInTheDocument();
    },
  );

  it("is shown for a signed-in web client", () => {
    render(
      <SessionProvider clientCode="Y1">
        <SignOutButton variant="text" />
      </SessionProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });
});
