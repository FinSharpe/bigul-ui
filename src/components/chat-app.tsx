"use client";

import { Thread } from "@/components/thread";
import { StreamProvider } from "@/providers/Stream";
import { ThreadProvider } from "@/providers/Thread";
import { SessionProvider } from "@/providers/Session";
import { ArtifactProvider } from "@/components/thread/artifact";
import { Toaster } from "@/components/ui/sonner";
import React from "react";
import type { AppTheme } from "@/lib/platform";

export function ChatApp({
  clientCode,
  embedded = false,
  appTheme = "bigul",
}: {
  clientCode: string;
  /** Shown inside the Bigul app's WebView (no sign-out there). */
  embedded?: boolean;
  /** The Bigul app's theme; the Super App is dark only. */
  appTheme?: AppTheme;
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
        {/* Without a theme provider the toaster follows the OS; the Super
            App is dark whatever the phone's setting. */}
        <Toaster {...(appTheme === "superapp" ? { theme: "dark" } : {})} />
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
