import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Jost } from "next/font/google";
import "./globals.css";
import { PlayerProvider } from "@/contexts/PlayerContext";
import MiniPlayer from "@/components/MiniPlayer";

const jost = Jost({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-jost" });

export const metadata: Metadata = {
  title: "mixBase",
  description: "Track the evolution of your mixes",
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
          <MiniPlayer />
          {children}
        </PlayerProvider>
      </body>
    </html>
  );
}
