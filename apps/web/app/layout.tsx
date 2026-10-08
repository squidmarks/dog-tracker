import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Dog Tracker",
  description: "Live GPS tracking for the dogs",
  // Makes "Add to Home Screen" on iOS open it full-screen, like an app, with this name under the icon.
  appleWebApp: { capable: true, title: "Dog Tracker", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // Next emits the modern mobile-web-app-capable; older iOS only honours the apple- spelling, so send both.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#2e86ab",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
