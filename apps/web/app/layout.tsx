import { BRAND } from "@ashniva/shared";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist_Mono, Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const CC_INSTALLATION_ID =
  process.env.NEXT_PUBLIC_ASHNIVA_CC_INSTALLATION_ID ?? "inst_marketing_local_dev_00000000000001";
const CC_LOADER_BASE =
  process.env.NEXT_PUBLIC_ASHNIVA_CC_LOADER_URL ?? "http://localhost:4500/api/v1/public/loader.js";
const CC_LOADER_SRC = `${CC_LOADER_BASE}${CC_LOADER_BASE.includes("?") ? "&" : "?"}i=${encodeURIComponent(CC_INSTALLATION_ID)}`;

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
        {/* Central Control static-site loader — Theme Studio publish applies without SDK bridge */}
        <Script
          src={CC_LOADER_SRC}
          strategy="afterInteractive"
          data-installation-id={CC_INSTALLATION_ID}
        />
      </body>
    </html>
  );
}
