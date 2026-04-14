import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Jost } from "next/font/google";
import "./globals.css";
import { PlayerProvider } from "@/contexts/PlayerContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import MiniPlayer from "@/components/MiniPlayer";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

const jost = Jost({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jost" });

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
  themeColor: "#080808",
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
    <html lang="en" className={`h-full ${jost.variable}`}>
      <body className="min-h-full" style={{ backgroundColor: "var(--bg-page)", color: "var(--text)" }}>
        <ThemeProvider>
          <PlayerProvider>
            <ServiceWorkerRegistrar />
            <MiniPlayer />
            {children}
          </PlayerProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
