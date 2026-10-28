import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
} from "react";
import { useId } from "react";
import type { ContentBlock } from "@langchain/core/messages";
import { LoaderCircle, Paperclip, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContentBlocksPreview } from "./ContentBlocksPreview";

const ACCEPTED_FILES =
  "image/jpeg,image/png,image/gif,image/webp,application/pdf";

export interface ChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  blocks: ContentBlock.Multimodal.Data[];
  onRemoveBlock: (index: number) => void;
  onFileInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  onStop: () => void;
  /** No conversation yet: the desktop card opens two lines tall. */
  isEmpty: boolean;
  /** An answer is streaming: send becomes stop. */
  isLoading: boolean;
  /** The stop request is in flight. */
  isStopping: boolean;
  /** Whether a new message can go now (not loading a conversation). */
  canSend: boolean;
  placeholder: string;
  dropRef: RefObject<HTMLDivElement | null>;
  dragOver: boolean;
}

/**
 * The message box, drawn as the FinSharpe composer without its effort
 * picker and mic. Phones get one rounded bar: attach, text, send. From
 * 1024px it is a card: text on top, attach on the left and send on the
 * right below it. One form either way, laid out by CSS grid areas, so the
 * first paint is already right. Enter sends, Shift+Enter breaks the line;
 * files come in through the paperclip, paste, or a drop on the box.
 */
export function ChatComposer({
  input,
  onInputChange,
  blocks,
  onRemoveBlock,
  onFileInput,
  onPaste,
  onSubmit,
  onStop,
  isEmpty,
  isLoading,
  isStopping,
  canSend,
  placeholder,
  dropRef,
  dragOver,
}: ChatComposerProps) {
  const fileInputId = useId();
  const hasContent = input.trim().length > 0 || blocks.length > 0;
  const sendable = canSend && hasContent;
  const hasBlocks = blocks.length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const round =
    "flex size-8 shrink-0 items-center justify-center rounded-full transition-all lg:size-9";

  return (
    <div
      ref={dropRef}
      className={cn(
        "chat-composer relative",
        dragOver && "border-primary bg-accent border-dashed",
      )}
    >
      <form
        onSubmit={onSubmit}
        aria-label="Message composer"
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1.5 p-2",
          "lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-x-2 lg:gap-y-3.5 lg:p-5",
          hasBlocks
            ? "[grid-template-areas:'preview_preview_preview'_'attach_text_send'] lg:[grid-template-areas:'preview_preview'_'text_text'_'attach_send']"
            : "[grid-template-areas:'attach_text_send'] lg:[grid-template-areas:'text_text'_'attach_send']",
        )}
      >
        {hasBlocks && (
          <ContentBlocksPreview
            blocks={blocks}
            onRemove={onRemoveBlock}
            size="sm"
            className="p-1 pb-0 [grid-area:preview] lg:p-0"
          />
        )}

        <button
          type="button"
          title="Attach file"
          aria-label="Upload PDF or image"
          onClick={() => document.getElementById(fileInputId)?.click()}
          className={cn(
            round,
            "bg-mint text-mint-foreground cursor-pointer justify-self-start [grid-area:attach] active:scale-95",
          )}
        >
          <Paperclip className="size-3.5 lg:size-[15px]" />
        </button>
        <input
          id={fileInputId}
          type="file"
          onChange={onFileInput}
          multiple
          accept={ACCEPTED_FILES}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />

        <textarea
          rows={1}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Your message"
          className={cn(
            "text-foreground placeholder:text-foreground/50 field-sizing-content resize-none border-0 bg-transparent outline-none [grid-area:text] focus-visible:outline-none",
            "max-h-[120px] min-w-0 px-1 py-1.5 text-[15px] leading-5",
            "lg:max-h-[240px] lg:px-0 lg:py-0 lg:leading-relaxed",
            isEmpty ? "lg:min-h-[3.25em]" : "lg:min-h-[1.625em]",
            // A narrow empty bar keeps its placeholder on one line.
            !input && "max-lg:overflow-hidden max-lg:whitespace-nowrap",
          )}
        />

        {isLoading ? (
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            title="Stop"
            aria-label="Stop response"
            className={cn(
              round,
              "text-destructive cursor-pointer justify-self-end bg-[var(--negative-container)] [grid-area:send] hover:brightness-[0.97] disabled:cursor-default",
            )}
          >
            {isStopping ? (
              <LoaderCircle className="size-3.5 animate-spin lg:size-[15px]" />
            ) : (
              <RefreshCw className="size-3.5 animate-spin lg:size-[15px]" />
            )}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!sendable}
            title="Send"
            aria-label="Send message"
            className={cn(
              round,
              "justify-self-end [grid-area:send]",
              sendable
                ? "brand-gradient cursor-pointer text-white shadow-xs"
                : "bg-foreground/10 text-foreground/30",
            )}
          >
            <Send
              className="size-[15px] lg:size-4"
              strokeWidth={2.5}
            />
          </button>
        )}
      </form>
    </div>
  );
}
