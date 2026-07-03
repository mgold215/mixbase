import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Jost, Bebas_Neue, Space_Mono } from "next/font/google";
import "./globals.css";
import { PlayerProvider } from "@/contexts/PlayerContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import MiniPlayer from "@/components/MiniPlayer";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import PullToRefresh from "@/components/PullToRefresh";
import SessionRefresher from "@/components/SessionRefresher";
import { SITE_URL } from "@/lib/site";

const jost = Jost({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jost" });
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
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
  modal,
}: Readonly<{
  children: ReactNode;
  modal: ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${jost.variable} ${bebasNeue.variable} ${spaceMono.variable}`}>
      <body className="min-h-full" style={{ backgroundColor: "var(--bg-page)", color: "var(--text)" }}>
        <ThemeProvider>
          <PlayerProvider>
            <ServiceWorkerRegistrar />
            <SessionRefresher />
            <PullToRefresh />
            <MiniPlayer />
            {children}
            {modal}
          </PlayerProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
