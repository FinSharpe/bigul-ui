import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionProvider } from "@/providers/Session";
import { ChatToolbar, MobileHeader } from "./mobile-chrome";

function renderHeader(embedded: boolean) {
  return render(
    <SessionProvider
      clientCode="Y09042341"
      embedded={embedded}
    >
      <MobileHeader />
    </SessionProvider>,
  );
}

describe("phone header", () => {
  it("opens an account sheet with the client and a sign-out form", async () => {
    const user = userEvent.setup();
    renderHeader(false);
    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("dialog", { name: "Account" })).toHaveTextContent(
      "Y09042341",
    );
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(signOut.closest("form")).toHaveAttribute("action", "/auth/logout");
  });

  it("draws no top bar inside the Bigul app, which has its own", () => {
    renderHeader(true);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByAltText("Mayra AI Assistant")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Account" }),
    ).not.toBeInTheDocument();
  });

  it("draws the logo bar in a browser", () => {
    renderHeader(false);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByAltText("Mayra AI Assistant")).toBeInTheDocument();
  });
});

describe("chat toolbar", () => {
  it("opens history and starts a new chat", async () => {
    const user = userEvent.setup();
    const onOpenHistory = vi.fn();
    const onNewChat = vi.fn();
    render(
      <ChatToolbar
        title="Conversations"
        historyOpen={false}
        onOpenHistory={onOpenHistory}
        onNewChat={onNewChat}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Chat history" }));
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
