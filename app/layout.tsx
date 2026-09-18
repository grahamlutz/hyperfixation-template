import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "__APP_NAME__",
};

export const viewport: Viewport = {
  // Crystal approves batches from a phone browser with nothing installed; the approval UI is
  // a mobile target first and a desktop one second.
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
