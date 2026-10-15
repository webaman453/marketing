import { PLATFORM_INFO, type PlatformBreakdown as Row } from "@ashniva/shared";
import { PlatformIcon } from "@/components/platform-icon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { money, moneyCompact, multiple, number } from "@/lib/format";

export function PlatformBreakdown({ rows, currency }: { rows: Row[]; currency: string }) {
  const total = rows.reduce((s, r) => s + r.metrics.spend, 0);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Spend by platform</CardTitle>
        <CardDescription>Share of spend and return for the selected period</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          {rows.map((r) => (
            <Tooltip key={r.platform}>
              <TooltipTrigger asChild>
                <div
                  className="h-full transition-[width] duration-700 ease-out first:rounded-l-full last:rounded-r-full"
                  style={{
                    width: `${total ? (r.metrics.spend / total) * 100 : 0}%`,
                    background: PLATFORM_INFO[r.platform].color,
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
                    <div className="truncate font-medium">{PLATFORM_INFO[r.platform].name}</div>
                    <div className="text-xs text-muted-foreground tabular">{(share * 100).toFixed(1)}% of spend</div>
                  </div>
                </div>
                <span className="w-20 text-right font-medium tabular">{moneyCompact(r.metrics.spend, currency)}</span>
                <span className="hidden w-14 text-right text-muted-foreground tabular sm:block">{number(r.metrics.conversions)}</span>
                <span className="w-14 text-right tabular">{multiple(r.metrics.roas)}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
