import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ROIstation OS — Master Panel",
  description: "Web sitesi, içerik, SEO, GEO ve yayın otomasyon merkezi",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
