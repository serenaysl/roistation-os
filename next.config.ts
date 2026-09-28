import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  // Keep Blob's Node/undici network layer intact rather than bundling it.
  serverExternalPackages: ["@vercel/blob"],
  // The SEO optimizer copies the connector kit into client repositories; ship those files with the route.
  outputFileTracingIncludes: { "/api/seo/optimize": ["./connectors/**/*"] },
  async headers() {
    const baseline = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      { source: "/:path*", headers: baseline },
      // The admin panel is never framed. /embed/<site> stays frameable: client sites load it in an iframe.
      { source: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
    ];
  },
};

export default nextConfig;
