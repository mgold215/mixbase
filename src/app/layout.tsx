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

const jost = Jost({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jost" });
const bebasNeue = Bebas_Neue({ subsets: ["latin"], weight: "400", variable: "--font-bebas" });
const spaceMono = Space_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
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
}: Readonly<{
  children: ReactNode;
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
          </PlayerProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
