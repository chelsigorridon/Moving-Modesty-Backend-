import type { NextConfig } from "next";

const framerAdminUrl = (process.env.FRAMER_ADMIN_URL ?? "https://holistic-brand-492217.framer.app").replace(/\/$/, "");

const nextConfig: NextConfig = {
  poweredByHeader: false,
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
