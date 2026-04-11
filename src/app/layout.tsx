import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { PlayerProvider } from "@/contexts/PlayerContext";
import MiniPlayer from "@/components/MiniPlayer";

export const metadata: Metadata = {
  title: "Mixfolio",
  description: "Track the evolution of your mixes",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-[#080808] text-[#f0f0f0] pb-16">
        <PlayerProvider>
          <MiniPlayer />
          {children}
        </PlayerProvider>
      </body>
    </html>
  );
}
