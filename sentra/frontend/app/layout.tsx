import type { Metadata, Viewport } from "next";
import { THEME_BOOTSTRAP } from "@/lib/theme";
import "./globals.css";

const DESCRIPTION =
  "Your wallet balance says what you have. Sentra says what you stand to " +
  "lose — continuous Value-at-Risk and Expected Shortfall for Solana " +
  "wallets, scored every 30 seconds.";

/**
 * metadataBase turns the relative icon and social-card paths into the
 * absolute URLs crawlers require. Without it the Open Graph image resolves
 * against nothing and the link unfurls as a bare URL — which is how it
 * behaved everywhere the project was actually shared.
 *
 * NEXT_PUBLIC_SITE_URL lets a fork or a preview deploy point at itself
 * instead of inheriting this repo's Pages URL.
 */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://abhist17.github.io/sentra";

/**
 * The ORIGIN, not the full site URL. Next prefixes asset paths with basePath
 * itself, so a metadataBase that already carries it yields
 * /sentra/sentra/opengraph-image.png — a 404 that only ever shows up as a
 * link preview silently failing to render.
 */
const ORIGIN = new URL(SITE_URL).origin;

export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: {
    default: "Sentra — Solana Portfolio Risk Monitor",
    template: "%s · Sentra",
  },
  description: DESCRIPTION,
  applicationName: "Sentra",
  keywords: [
    "Solana",
    "Value at Risk",
    "Expected Shortfall",
    "portfolio risk",
    "DeFi risk",
    "risk monitoring",
  ],
  openGraph: {
    type: "website",
    siteName: "Sentra",
    title: "Sentra — Solana Portfolio Risk Monitor",
    description: DESCRIPTION,
    url: SITE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title: "Sentra — Solana Portfolio Risk Monitor",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#fcfcfd" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint, so the page never
            renders dark and then flips to light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
