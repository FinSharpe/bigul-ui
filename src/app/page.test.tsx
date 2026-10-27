import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPage from "./page";

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
vi.mock("@/components/chat-app", () => ({ ChatApp: () => null }));

beforeEach(() => {
  mocks.session = { clientCode: "TEST0001" };
  mocks.embedded = false;
  mocks.redirect.mockClear();
});

describe("chat page", () => {
  it("sends a signed-out visitor to sign in", async () => {
    mocks.session = null;
    await expect(ChatPage()).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it.each([true, false])(
    "tells the chat whether it is inside the Bigul app (%s), which hides sign-out",
    async (embedded) => {
      mocks.embedded = embedded;
      const element = await ChatPage();
      expect(element.props).toEqual({ clientCode: "TEST0001", embedded });
    },
  );
});
