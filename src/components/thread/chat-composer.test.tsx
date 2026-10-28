import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps, type FormEvent } from "react";
import { ChatComposer } from "./chat-composer";

type Props = ComponentProps<typeof ChatComposer>;

function Composer(overrides: Partial<Props>) {
  const [input, setInput] = useState(overrides.input ?? "");
  return (
    <ChatComposer
      blocks={[]}
      onRemoveBlock={() => {}}
      onFileInput={() => {}}
      onPaste={() => {}}
      onSubmit={(event) => event.preventDefault()}
      onStop={() => {}}
      isEmpty
      isLoading={false}
      isStopping={false}
      canSend
      placeholder="Ask anything…"
      dropRef={{ current: null }}
      dragOver={false}
      {...overrides}
      input={input}
      onInputChange={setInput}
    />
  );
}

describe("chat composer", () => {
  it("sends on Enter once there is text, and not before", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(<Composer onSubmit={onSubmit} />);
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();

    const box = screen.getByRole("textbox", { name: "Your message" });
    await user.type(box, "Analyse TCS");
    expect(send).toBeEnabled();
    await user.type(box, "{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(box, "{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("holds sending while a conversation loads", async () => {
    const user = userEvent.setup();
    render(<Composer canSend={false} />);
    await user.type(
      screen.getByRole("textbox", { name: "Your message" }),
      "Hi",
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("turns send into stop while an answer streams", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const { rerender } = render(
      <Composer
        isLoading
        onStop={onStop}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <Composer
        isLoading
        isStopping
        onStop={onStop}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Stop response" }),
    ).toBeDisabled();
  });

  it("opens the file picker from the attach button", async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer />);
    const picker =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(picker, "click");
    await user.click(
      screen.getByRole("button", { name: "Upload PDF or image" }),
    );
    expect(click).toHaveBeenCalledOnce();
  });
});
