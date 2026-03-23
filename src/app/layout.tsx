import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mixfolio",
  description: "Track the evolution of your mixes",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-[#080808] text-[#f0f0f0]">{children}</body>
    </html>
  );
}
