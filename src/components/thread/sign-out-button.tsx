import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearChatStorage } from "@/lib/chat-storage";
import { cn } from "@/lib/utils";
import { useSession } from "@/providers/Session";
import { TooltipIconButton } from "./tooltip-icon-button";

/**
 * A real form POST, so sign-out works before hydration too. Hidden inside
 * the Bigul app, which owns sign-in and sign-out.
 *
 * `icon`: a header icon. `text`: a labelled ghost button. `row`: the quiet
 * round icon at the end of the sidebar's account row. `sheet`: the full-width
 * outlined pill in the phone's account sheet.
 */
export function SignOutButton({
  variant,
  className,
}: {
  variant: "icon" | "text" | "row" | "sheet";
  className?: string;
}) {
  const { embedded } = useSession();
  if (embedded) return null;
  return (
    <form
      method="post"
      action="/auth/logout"
      onSubmit={clearChatStorage}
      className={cn("flex", className)}
    >
      {variant === "icon" ? (
        <TooltipIconButton
          type="submit"
          tooltip="Sign out"
          variant="ghost"
          className="size-11 rounded-full"
        >
          <LogOut className="size-5" />
        </TooltipIconButton>
      ) : variant === "row" ? (
        <button
          type="submit"
          title="Sign out"
          aria-label="Sign out"
          className="text-muted-foreground hover:text-destructive flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-[var(--negative-container)]"
        >
          <LogOut className="size-4" />
        </button>
      ) : variant === "sheet" ? (
        <button
          type="submit"
          className="border-primary/30 text-primary hover:bg-accent flex h-[52px] w-full cursor-pointer items-center justify-center rounded-full border text-sm font-medium transition-colors"
        >
          Sign out
        </button>
      ) : (
        <Button
          type="submit"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-9 rounded-full px-3 text-xs font-medium"
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      )}
    </form>
  );
}
