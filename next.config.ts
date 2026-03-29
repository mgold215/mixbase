import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Proxy buffers request bodies — raise limit to handle large WAV/AIFF files
    proxyClientMaxBodySize: '200mb',
  },
  // Allow images from Supabase storage and Replicate
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'mdefkqaawrusoaojstpq.supabase.co' },
      { protocol: 'https', hostname: '*.replicate.delivery' },
      { protocol: 'https', hostname: 'replicate.delivery' },
      { protocol: 'https', hostname: 'pbxt.replicate.delivery' },
    ],
  },
};

export default nextConfig;
