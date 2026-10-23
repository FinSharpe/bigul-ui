import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearChatStorage } from "@/lib/chat-storage";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./tooltip-icon-button";

/** A real form POST, so sign-out works before hydration too. */
export function SignOutButton({
  variant,
  className,
}: {
  variant: "icon" | "text";
  className?: string;
}) {
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
