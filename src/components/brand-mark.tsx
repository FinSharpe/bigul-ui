import Image from "next/image";
import { cn } from "@/lib/utils";

/** Mayra AI Assistant logo (wordmark). Size it by height, e.g. `h-8`. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <Image
      src="/mayra-logo.png"
      alt="Mayra AI Assistant"
      width={645}
      height={167}
      priority
      className={cn("w-auto shrink-0", className)}
    />
  );
}
