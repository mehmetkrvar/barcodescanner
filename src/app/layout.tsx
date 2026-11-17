import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Depo Terminali - Hızlı Barkod Okuyucu",
  description:
    "Depolar için ultra düşük gecikmeli, çevrimdışı destekli mobil web barkod okuyucu terminali.",
  applicationName: "DepoBarkod",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DepoBarkod",
  },
  icons: {
    icon: "/icons/icon-192.svg",
    apple: "/icons/icon-192.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr" className="dark">
      <body className="bg-zinc-950 text-zinc-50 antialiased selection:bg-emerald-500/30">
        {children}
      </body>
    </html>
  );
}
