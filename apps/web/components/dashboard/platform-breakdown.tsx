import { PLATFORM_INFO, PLATFORMS, type Platform, type PlatformBreakdown as Row } from "@ashniva/shared";
import { PlatformIcon } from "@/components/platform-icon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { money, moneyCompact, multiple, number } from "@/lib/format";

/**
 * Chart colours for the spend bar. Brand colours alone collide (Meta, LinkedIn, Microsoft and
 * Taboola are all near-identical blues; X and Apple are both black), so a few are shifted to a
 * related shade. Every pair of visible platforms is at least ΔE2000 15 apart, and none is too
 * dark to see on the dark theme.
 */
export const SPEND_COLORS: Partial<Record<Platform, string>> = {
  META: "#0866FF",
  GOOGLE: "#188038",
  LINKEDIN: "#003F7F",
  MICROSOFT: "#00A4EF",
  SNAPCHAT: "#F7C600",
  PINTEREST: "#E60023",
  AMAZON: "#FF9900",
  X: "#52525B",
  APPLE: "#A1A1AA",
  SPOTIFY: "#1ED760",
  CRITEO: "#FE5000",
  TABOOLA: "#B197FC",
  OUTBRAIN: "#7C2D12",
  TRADEDESK: "#0D9488",
  YAHOO: "#6001D2",
  SHOPIFY: "#004C3F",
};

export const spendColor = (platform: Platform) => SPEND_COLORS[platform] ?? PLATFORM_INFO[platform].color;

/** Biggest spend first; equal spend falls back to the fixed platform order, so the bar never reshuffles. */
export const sortBySpend = (rows: Row[]) =>
  [...rows].sort((a, b) => b.metrics.spend - a.metrics.spend || PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));

export function PlatformBreakdown({ rows: unsorted, currency }: { rows: Row[]; currency: string }) {
  const rows = sortBySpend(unsorted);
  const total = rows.reduce((s, r) => s + r.metrics.spend, 0);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Spend by platform</CardTitle>
        <CardDescription>Share of spend and return for the selected period</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* A hairline gap between segments keeps neighbours apart even when their colours are close. */}
        <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
          {rows.filter((r) => r.metrics.spend > 0).map((r) => (
            <Tooltip key={r.platform}>
              <TooltipTrigger asChild>
                <div
                  className="h-full transition-[width] duration-700 ease-out first:rounded-l-full last:rounded-r-full"
                  style={{
                    width: `${total ? (r.metrics.spend / total) * 100 : 0}%`,
                    background: spendColor(r.platform),
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {PLATFORM_INFO[r.platform].name} · {money(r.metrics.spend, currency)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="divide-y">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 pb-2 text-xs font-medium text-muted-foreground">
            <span>Platform</span>
            <span className="w-20 text-right">Spend</span>
            <span className="hidden w-14 text-right sm:block">Conv.</span>
            <span className="w-14 text-right">ROAS</span>
          </div>
          {rows.map((r) => {
            const share = total ? r.metrics.spend / total : 0;
            return (
              <div key={r.platform} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 py-2.5 text-sm">
                <div className="flex min-w-0 items-center gap-2.5">
                  <PlatformIcon platform={r.platform} size="md" />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: spendColor(r.platform) }} />
                      <span className="truncate font-medium">{PLATFORM_INFO[r.platform].name}</span>
                    </div>
                    <div className="text-xs text-muted-foreground tabular">{(share * 100).toFixed(1)}% of spend</div>
                  </div>
                </div>
                <span className="w-20 text-right font-medium tabular">{moneyCompact(r.metrics.spend, currency)}</span>
                <span className="hidden w-14 text-right text-muted-foreground tabular sm:block">{number(r.metrics.conversions, { currency })}</span>
                <span className="w-14 text-right tabular">{multiple(r.metrics.roas)}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
