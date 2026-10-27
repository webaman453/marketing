"use client";

import { useEffect, type ReactNode } from "react";

type ThemeTokens = {
  meta?: { name?: string; version?: number; isProductDefault?: boolean };
  colors?: Record<string, { value?: string } | string | undefined>;
  typography?: Record<string, { value?: string } | string | undefined>;
};

function tokenValue(entry: { value?: string } | string | undefined): string | undefined {
  if (!entry) return undefined;
  if (typeof entry === "string") return entry;
  return entry.value;
}

function isDarkColor(hex: string): boolean {
  const raw = hex.replace("#", "").trim();
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return false;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L < 0.45;
}

/** Drop remote overrides so globals.css (native Ads UI) wins again. */
function clearInjectedTheme() {
  if (typeof document === "undefined") return;
  document.getElementById("nexus-theme-override")?.remove();
}

function injectMarketingTokens(tokens: ThemeTokens) {
  if (typeof document === "undefined") return;

  // Reset / product baseline → keep the built-in UI exactly as shipped.
  if (tokens.meta?.isProductDefault === true) {
    clearInjectedTheme();
    return;
  }

  const styleId = "nexus-theme-override";
  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  const primary = tokenValue(tokens.colors?.primary) || "#4F46E5";
  const secondary = tokenValue(tokens.colors?.secondary) || primary;
  const background = tokenValue(tokens.colors?.background) || "#F7F8FB";
  const surface = tokenValue(tokens.colors?.surface) || "#FFFFFF";
  const textPrimary = tokenValue(tokens.colors?.textPrimary) || "#1E1B4B";
  const textSecondary = tokenValue(tokens.colors?.textSecondary) || "#64748B";
  const border = tokenValue(tokens.colors?.border) || "#E2E8F0";
  const error = tokenValue(tokens.colors?.error) || "#DC2626";
  const success = tokenValue(tokens.colors?.success) || "#059669";
  const onPrimary = isDarkColor(primary) ? "#ffffff" : "#1e1b4b";
  const fontFamily = tokenValue(tokens.typography?.fontFamily);

  const lines = [
    `:root, .dark {`,
    `  --primary: ${primary};`,
    `  --primary-foreground: ${onPrimary};`,
    `  --secondary: color-mix(in srgb, ${secondary} 12%, ${surface});`,
    `  --secondary-foreground: ${textPrimary};`,
    `  --background: ${background};`,
    `  --foreground: ${textPrimary};`,
    `  --card: ${surface};`,
    `  --card-foreground: ${textPrimary};`,
    `  --popover: ${surface};`,
    `  --popover-foreground: ${textPrimary};`,
    `  --muted: color-mix(in srgb, ${background} 70%, ${border});`,
    `  --muted-foreground: ${textSecondary};`,
    `  --accent: color-mix(in srgb, ${primary} 8%, ${surface});`,
    `  --accent-foreground: ${textPrimary};`,
    `  --destructive: ${error};`,
    `  --success: ${success};`,
    `  --border: ${border};`,
    `  --input: ${border};`,
    `  --ring: ${primary};`,
    `  --sidebar-primary: ${primary};`,
    `  --sidebar-primary-foreground: ${onPrimary};`,
    `  --sidebar-ring: ${primary};`,
    `  --nexus-color-primary: ${primary};`,
    `  --nexus-color-secondary: ${secondary};`,
    `  --nexus-color-background: ${background};`,
    `  --nexus-color-surface: ${surface};`,
    `  --nexus-color-textPrimary: ${textPrimary};`,
    `  --nexus-color-textSecondary: ${textSecondary};`,
    `  --nexus-color-border: ${border};`,
    fontFamily ? `  --font-sans: ${fontFamily};` : "",
    `}`,
  ].filter(Boolean);

  styleEl.textContent = lines.join("\n");
}

async function fetchRuntime(): Promise<ThemeTokens | null | undefined> {
  try {
    const res = await fetch("/api/central-control/runtime", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.enabled) return null;
    if (!data?.theme?.tokens) return undefined;
    return data.theme.tokens as ThemeTokens;
  } catch {
    return null;
  }
}

/**
 * Central Control theme bridge for Marketing / Ads.
 * - Custom published theme → inject CSS vars
 * - Product default / Reset (`isProductDefault`) → clear overrides → native UI
 */
export function NexusThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const apply = async () => {
      const tokens = await fetchRuntime();
      if (cancelled) return;
      if (tokens === null) return;
      if (tokens === undefined) {
        clearInjectedTheme();
        return;
      }
      injectMarketingTokens(tokens);
    };

    void apply();

    try {
      es = new EventSource("/api/central-control/theme/stream");
      es.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data);
          if (parsed?.event === "THEME_REFRESH") void apply();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* EventSource unavailable */
    }

    pollTimer = setInterval(() => void apply(), 60_000);

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  return <>{children}</>;
}
