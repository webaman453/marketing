import { BRAND } from "@ashniva/shared";
import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import Script from "next/script";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: `${BRAND.name} · ${BRAND.tagline}`, template: `%s · ${BRAND.name}` },
  description:
    "Run and measure Meta, Google, YouTube, TikTok and LinkedIn ads from one dashboard. Built for marketing teams and agencies.",
  applicationName: BRAND.name,
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfd" },
    { media: "(prefers-color-scheme: dark)", color: "#17181f" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full`} suppressHydrationWarning>
      <body className="min-h-full">
        <Providers>{children}</Providers>
        <Script
          src="https://control.ashniva.com/api/v1/public/loader.js?i=inst_8d376e4c01a58ee0ef363e37988d89c7"
          strategy="beforeInteractive"
          data-installation-id="inst_8d376e4c01a58ee0ef363e37988d89c7"
        />
      </body>
    </html>
  );
}
