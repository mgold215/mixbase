import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives in a subfolder of a larger repo. Pin the workspace root to
  // THIS directory so Next doesn't climb up to the parent project's lockfile
  // (and accidentally pull in its instrumentation/Sentry files).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
