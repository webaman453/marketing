import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4100";

const FRAME_ANCESTORS = [
  "'self'",
  "https://control.ashniva.com",
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:3200", "http://127.0.0.1:3200"]),
];

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
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Central Control's Theme Studio may frame the site; its local dev server only outside production.
          { key: "Content-Security-Policy", value: `frame-ancestors ${FRAME_ANCESTORS.join(" ")}` },
        ],
      },
    ];
  },
};

export default nextConfig;
