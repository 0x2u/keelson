import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider } from "next-themes";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// The display face of the name and of page titles: Sora (SIL Open Font License, app/fonts/Sora-OFL.txt), a Latin subset
// kept in the repository so that a build needs no network.
const display = localFont({ src: "./fonts/Sora-latin.woff2", variable: "--font-sora", weight: "400 700", display: "swap" });

// The content security policy carries a nonce that changes per response: no page can be prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Keelson", template: "%s · Keelson" },
  description: "Deploy and operate containerized apps on your own servers.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#070f18" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}>
      <body className="min-h-screen font-sans">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={300}>
            <a
              href="#main"
              className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
            >
              Skip to content
            </a>
            {children}
          </TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
