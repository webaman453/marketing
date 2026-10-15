import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4100";

const nextConfig: NextConfig = {
  // The dashboard is client-rendered behind auth, so partial prerendering
  // (cacheComponents) adds little and would force Suspense around URL hooks.
  cacheComponents: false,
  transpilePackages: ["@ashniva/shared"],
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Same-origin API: the browser talks to /api/* and Next proxies to the Node API,
  // so auth cookies stay first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
