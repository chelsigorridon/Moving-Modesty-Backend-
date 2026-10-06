import type { NextConfig } from "next";

const framerAdminUrl = (process.env.FRAMER_ADMIN_URL ?? "https://holistic-brand-492217.framer.app").replace(/\/$/, "");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
  turbopack: {
    root: process.cwd(),
  },
  redirects() {
    return [
      { source: "/login", destination: `${framerAdminUrl}/admin/login`, permanent: false },
      { source: "/dashboard", destination: `${framerAdminUrl}/admin`, permanent: false },
      { source: "/orders/:path*", destination: `${framerAdminUrl}/admin/orders`, permanent: false },
      { source: "/products/:path*", destination: `${framerAdminUrl}/admin/products`, permanent: false },
      { source: "/inventory", destination: `${framerAdminUrl}/admin`, permanent: false },
      { source: "/delivery", destination: `${framerAdminUrl}/admin/orders`, permanent: false },
      { source: "/settings", destination: `${framerAdminUrl}/admin`, permanent: false },
      { source: "/support", destination: `${framerAdminUrl}/admin`, permanent: false },
    ];
  },
};

export default nextConfig;
