import type { Metadata } from "next";
import "./globals.css";
import { DM_Sans } from "next/font/google";
import localFont from "next/font/local";
import React from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { appTheme } from "@/lib/auth/session";

const inter = localFont({
  src: [
    { path: "./fonts/Inter-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/Inter-Medium.ttf", weight: "500", style: "normal" },
    { path: "./fonts/Inter-SemiBold.ttf", weight: "600", style: "normal" },
  ],
  preload: true,
  display: "swap",
  variable: "--font-inter",
});

// The Super App's font. Not preloaded: only that app's WebView uses it.
const dmSans = DM_Sans({
  subsets: ["latin", "latin-ext"],
  // DM Sans is a variable font: one file per subset carries every weight.
  // (A weight list repeats that file, which Turbopack's build rejects.)
  weight: "variable",
  style: "normal",
  preload: false,
  display: "swap",
  variable: "--font-dm-sans",
});

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
  const superApp = (await appTheme()) === "superapp";
  return (
    <html
      lang="en"
      data-theme={superApp ? "superapp" : undefined}
      className={[inter.variable, dmSans.variable, superApp ? "dark" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <body>
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
