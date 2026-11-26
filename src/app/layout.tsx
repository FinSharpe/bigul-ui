import type { Metadata } from "next";
import "./globals.css";
import React from "react";
import { preload } from "react-dom";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { appTheme } from "@/lib/auth/session";
import type { AppTheme } from "@/lib/platform";

// Each theme preloads only its own font files (declared in globals.css).
// DM Sans' latin-ext file loads on demand, through its unicode-range.
const FONT_PRELOADS: Readonly<
  Record<AppTheme, readonly { href: string; type: string }[]>
> = {
  bigul: [
    { href: "/fonts/app/Inter-Regular.ttf", type: "font/ttf" },
    { href: "/fonts/app/Inter-Medium.ttf", type: "font/ttf" },
    { href: "/fonts/app/Inter-SemiBold.ttf", type: "font/ttf" },
  ],
  superapp: [{ href: "/fonts/app/DMSans-latin.woff2", type: "font/woff2" }],
};

const description =
  "Mayra AI is Bigul's research assistant. Analyse Indian stocks and mutual funds, compare them side by side, and get clear answers to personal finance questions.";

export const metadata: Metadata = {
  title: { default: "Mayra AI", template: "%s · Mayra AI" },
  description,
  applicationName: "Mayra AI",
  openGraph: {
    type: "website",
    siteName: "Mayra AI",
    title: "Mayra AI",
    description,
  },
  twitter: { card: "summary", title: "Mayra AI", description },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The app cookie names the Bigul app this WebView belongs to. The Super App
  // is dark only; the default theme keeps its light look and no attributes.
  const theme = await appTheme();
  for (const font of FONT_PRELOADS[theme])
    preload(font.href, { as: "font", type: font.type, crossOrigin: "" });
  const superApp = theme === "superapp";
  return (
    <html
      lang="en"
      data-theme={superApp ? "superapp" : undefined}
      className={superApp ? "dark" : undefined}
    >
      <body>
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
