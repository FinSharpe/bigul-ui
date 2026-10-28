import { useState } from "react";
import { motion, type PanInfo } from "framer-motion";
import { PanelLeft, Plus, UserRound } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useSession } from "@/providers/Session";
import { SignOutButton } from "./sign-out-button";

// A drag past this, or a flick, dismisses the account sheet.
const DISMISS_OFFSET = 80;
const DISMISS_VELOCITY = 500;

// Small round controls keep a 44px touch target around their 32px circle.
const TOUCH_TARGET =
  "relative after:absolute after:-inset-1.5 after:content-['']";

/**
 * The phone layout's top bar (below 1024px): the logo on the left, the
 * account on the right. Padding-top clears a notch when the page is drawn
 * edge to edge. Inside the Bigul app there is none: the app's own bar is
 * already above the chat.
 */
export function MobileHeader() {
  const { embedded } = useSession();
  if (embedded) return null;
  return (
    <header
      className="bg-background z-30 flex shrink-0 items-center justify-between px-5 select-none lg:hidden"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        height: "calc(56px + env(safe-area-inset-top))",
      }}
    >
      <BrandMark className="h-7" />
      <AccountMenu />
    </header>
  );
}

/** The header avatar and its bottom sheet: who is signed in, and Sign out. */
function AccountMenu() {
  const { clientCode } = useSession();
  const [open, setOpen] = useState(false);
  if (!clientCode) return null;

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY)
      setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={clientCode}
        aria-label="Account"
        aria-haspopup="dialog"
        className={`bg-mint text-mint-foreground border-primary/10 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border ${TOUCH_TARGET}`}
      >
        <UserRound className="size-4" />
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
      >
        <SheetContent
          side="bottom"
          showClose={false}
          aria-describedby={undefined}
          className="bg-card mx-auto max-w-[560px] gap-0 rounded-t-[30px] border-0"
        >
          <motion.div
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={onDragEnd}
            className="touch-pan-y"
          >
            <div className="flex justify-center pt-[18px] pb-2">
              <span className="bg-border h-1 w-9 rounded-full" />
            </div>
            <div
              className="px-5 pt-2"
              style={{
                paddingBottom: "max(20px, env(safe-area-inset-bottom))",
              }}
            >
              <SheetTitle className="sr-only">Account</SheetTitle>
              <div className="flex items-center gap-3 py-1.5">
                <span className="bg-secondary text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
                  <UserRound className="size-[18px]" />
                </span>
                <p className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium">
                    {clientCode}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    Signed in to Mayra AI
                  </span>
                </p>
              </div>
              <SignOutButton
                variant="sheet"
                className="mt-4 w-full"
              />
            </div>
          </motion.div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The phone layout's slim bar over the conversation: history on the left,
 * a new chat on the right. Desktop has both in the sidebar instead.
 */
export function ChatToolbar({
  title,
  historyOpen,
  onOpenHistory,
  onNewChat,
}: {
  title: string;
  historyOpen: boolean;
  onOpenHistory: () => void;
  onNewChat: () => void;
}) {
  return (
    <div className="border-border/60 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 lg:hidden">
      <button
        type="button"
        onClick={onOpenHistory}
        title="Chat history"
        aria-label="Chat history"
        aria-expanded={historyOpen}
        className={`hover-tint border-border text-foreground flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border ${TOUCH_TARGET}`}
      >
        <PanelLeft className="size-[15px]" />
      </button>
      <span className="text-muted-foreground min-w-0 truncate text-[11px] font-medium">
        {title}
      </span>
      <button
        type="button"
        onClick={onNewChat}
        title="New chat"
        aria-label="New chat"
        className={`hover-tint border-border text-primary flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border ${TOUCH_TARGET}`}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
