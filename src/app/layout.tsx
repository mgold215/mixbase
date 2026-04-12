import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Jost } from "next/font/google";
import "./globals.css";
import { PlayerProvider } from "@/contexts/PlayerContext";
import MiniPlayer from "@/components/MiniPlayer";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

const jost = Jost({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-jost" });

export const metadata: Metadata = {
  title: "mixBase",
  description: "Rough-to-release. Version control for music.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "mixBase",
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
      <body className="min-h-full bg-[#080808] text-[#f0f0f0] pb-16">
        <PlayerProvider>
          <ServiceWorkerRegistrar />
          <MiniPlayer />
          {children}
        </PlayerProvider>
      </body>
    </html>
  );
}
