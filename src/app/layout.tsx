import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Bebas_Neue, Space_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { PlayerProvider } from "@/contexts/PlayerContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import MiniPlayer from "@/components/MiniPlayer";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import PullToRefresh from "@/components/PullToRefresh";
import SessionRefresher from "@/components/SessionRefresher";
import { SITE_URL } from "@/lib/site";

// Jost is SELF-HOSTED, unlike the other two, and that asymmetry is deliberate.
//
// `next/font/google` downloads the font at BUILD time. On 2026-08-15 Google
// began serving Jost @font-face URLs that 404 for some CDN edges: Railway's
// builder got `.../jost/v20/92z8tBhP…woff2` → 404, which Turbopack escalates
// from a warning into 12 "Can't resolve @vercel/turbopack-next/internal/font/
// google/font" errors and a failed build. It reproduced on every Railway build
// while a cold local build (different edge) succeeded — so it was not cacheable,
// not retryable, and not ours to fix. That made a working production deploy
// contingent on Google's CDN, which is not an acceptable dependency for shipping.
//
// The file below is the same latin variable woff2 Google serves (26 KB, OFL),
// vendored so the build has no network dependency at all. It is a VARIABLE font
// covering 100–900, which is why one file replaces the four weights the previous
// `weight: ["400","500","600","700"]` requested — the rendered result is
// unchanged. Bebas Neue and Space Mono still come from next/font/google; move
// them here too if they ever break the same way.
const jost = localFont({
  src: "./fonts/jost-latin-var.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-jost",
});
const bebasNeue = Bebas_Neue({ subsets: ["latin"], weight: "400", variable: "--font-bebas" });
const spaceMono = Space_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
  // metadataBase lets every relative OpenGraph/Twitter image URL below resolve
  // to an absolute production URL — required for share-preview cards to load.
  metadataBase: new URL(SITE_URL),
  title: "mixBASE",
  description: "Rough-to-release. Version control for music.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "mixBASE",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
  // Site-wide share-preview defaults. Individual routes (e.g. the landing page)
  // override these with page-specific copy. The icon is square, so we use the
  // "summary" Twitter card (not summary_large_image, which wants a 1200x630).
  openGraph: {
    type: "website",
    siteName: "mixBASE",
    title: "mixBASE — Rough-to-release. Version control for music.",
    description: "Rough-to-release. Version control for music.",
    url: "/",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: "mixBASE" }],
  },
  twitter: {
    card: "summary",
    title: "mixBASE — Rough-to-release. Version control for music.",
    description: "Rough-to-release. Version control for music.",
    images: ["/icons/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0d0b08",
  width: "device-width",
  initialScale: 1,
  // Zoom is intentionally left enabled (no maximumScale / userScalable:false):
  // disabling it fails WCAG 1.4.4 (Resize Text) and is an accessibility blocker.
  // iOS auto-zoom-on-focus is prevented by keeping form controls at ≥16px
  // (see globals.css), not by locking the viewport.
};

// Runs before first paint to set data-theme from the saved preference, so
// light-mode users don't get a dark flash on every load (ThemeContext otherwise
// only applies the attribute in a post-hydration effect).
const themeInitScript = `(function(){try{var t=localStorage.getItem('mixbase-theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({
  children,
  modal,
}: Readonly<{
  children: ReactNode;
  modal: ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${jost.variable} ${bebasNeue.variable} ${spaceMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full" style={{ backgroundColor: "var(--bg-page)", color: "var(--text)" }}>
        <ThemeProvider>
          <PlayerProvider>
            <ServiceWorkerRegistrar />
            <SessionRefresher />
            <PullToRefresh />
            <MiniPlayer />
            {/* Single <main> landmark for the primary page content (accessibility:
                screen readers can jump straight to it). The modal slot and the
                global mini-player sit outside it as overlays/controls. */}
            <main>{children}</main>
            {modal}
          </PlayerProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
