import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Moving Modesty Admin",
    template: "%s · Moving Modesty",
  },
  description: "Orders, inventory and fulfilment for Moving Modesty.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
