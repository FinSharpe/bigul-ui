"use client";

import { Thread } from "@/components/thread";
import { StreamProvider } from "@/providers/Stream";
import { ThreadProvider } from "@/providers/Thread";
import { SessionProvider } from "@/providers/Session";
import { ArtifactProvider } from "@/components/thread/artifact";
import { Toaster } from "@/components/ui/sonner";
import React from "react";

export function ChatApp({
  clientCode,
  embedded = false,
}: {
  clientCode: string;
  /** Shown inside the Bigul app's WebView (no sign-out there). */
  embedded?: boolean;
}): React.ReactNode {
  return (
    <SessionProvider
      clientCode={clientCode}
      embedded={embedded}
    >
      <React.Suspense
        fallback={
          <div
            className="text-muted-foreground flex h-dvh items-center justify-center text-sm"
            role="status"
          >
            Loading conversation…
          </div>
        }
      >
        <Toaster />
        <ThreadProvider>
          <StreamProvider>
            <ArtifactProvider>
              <Thread />
            </ArtifactProvider>
          </StreamProvider>
        </ThreadProvider>
      </React.Suspense>
    </SessionProvider>
  );
}
