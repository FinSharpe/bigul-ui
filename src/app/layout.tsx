import type { Metadata } from "next";
import "./globals.css";
import localFont from "next/font/local";
import React from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";

const inter = localFont({
  src: [
    { path: "./fonts/Inter-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/Inter-Medium.ttf", weight: "500", style: "normal" },
    { path: "./fonts/Inter-SemiBold.ttf", weight: "600", style: "normal" },
  ],
  preload: true,
  display: "swap",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
