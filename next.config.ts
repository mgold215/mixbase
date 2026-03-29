import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
