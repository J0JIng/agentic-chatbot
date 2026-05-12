import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "firebasestorage.googleapis.com" },
      { protocol: "https", hostname: "cdn-icons-png.freepik.com" },
      { protocol: "https", hostname: "ccweb.imgix.net" },
      { protocol: "https", hostname: "**.cloudfront.net" },
      { protocol: "https", hostname: "s3.amazonaws.com" },
      { protocol: "https", hostname: "prod-discovery.edx-cdn.org" },
    ],
  },
};

export default nextConfig;
