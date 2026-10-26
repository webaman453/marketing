import type { Platform } from "@ashniva/shared";
import { LogoMark } from "@/components/brand";
import { PlatformIcon } from "@/components/platform-icon";

/** Static, illustrative product screenshot built from markup (no real customer data). */
export function ProductPreview() {
  const kpis = [
    { label: "Spend", value: "₹31.9L", delta: "+17.0%", good: true },
    { label: "Revenue", value: "₹1.2Cr", delta: "+14.2%", good: true },
    { label: "ROAS", value: "3.88×", delta: "−2.6%", good: false },
    { label: "Conversions", value: "8,325", delta: "+9.2%", good: true },
  ];
  const rows: { p: Platform; name: string; spend: string; roas: string }[] = [
    { p: "GOOGLE", name: "Performance Max – All Products", spend: "₹6,35,057", roas: "3.6×" },
    { p: "META", name: "Festive Sale – Prospecting", spend: "₹5,66,176", roas: "3.5×" },
    { p: "GOOGLE", name: "YouTube – Collection Launch", spend: "₹2,79,729", roas: "0.7×" },
    { p: "LINKEDIN", name: "Lead gen – Decision makers", spend: "₹1,94,585", roas: "2.1×" },
  ];

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-2xl shadow-primary/10 ring-1 ring-black/5" aria-hidden>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 rounded-md bg-background px-3 py-0.5 text-[11px] text-muted-foreground">app.ashniva.com/overview</span>
      </div>
      <div className="flex">
        <div className="hidden w-44 shrink-0 flex-col gap-1 border-r p-3 sm:flex">
          <div className="mb-3 flex items-center gap-2">
            <LogoMark className="size-6 rounded-md" />
            <span className="text-xs font-semibold">Ashniva Retail</span>
          </div>
          {["Overview", "Campaigns", "Integrations", "Activity log"].map((n, i) => (
            <div key={n} className={`rounded-md px-2 py-1.5 text-[11px] ${i === 0 ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"}`}>
              {n}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-3 p-4">
          <div className="text-sm font-semibold">Overview</div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {kpis.map((k) => (
              <div key={k.label} className="rounded-lg border p-2.5">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  {k.label}
                  <span className={k.good ? "text-success" : "text-destructive"}>{k.delta}</span>
                </div>
                <div className="mt-1 text-base font-semibold tabular">{k.value}</div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border p-3">
            <div className="mb-2 text-[11px] font-medium">Spend &amp; revenue</div>
            <svg viewBox="0 0 400 90" className="h-24 w-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="pv-a" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--chart-2)" stopOpacity="0.3" />
                  <stop offset="1" stopColor="var(--chart-2)" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="pv-b" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.25" />
                  <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0 52 C40 40 60 58 100 44 S160 30 200 38 S260 22 300 30 S360 18 400 22 L400 90 L0 90Z" fill="url(#pv-a)" />
              <path d="M0 52 C40 40 60 58 100 44 S160 30 200 38 S260 22 300 30 S360 18 400 22" fill="none" stroke="var(--chart-2)" strokeWidth="2" />
              <path d="M0 70 C40 64 70 72 100 66 S160 60 200 63 S260 54 300 58 S360 50 400 52 L400 90 L0 90Z" fill="url(#pv-b)" />
              <path d="M0 70 C40 64 70 72 100 66 S160 60 200 63 S260 54 300 58 S360 50 400 52" fill="none" stroke="var(--chart-1)" strokeWidth="2" />
            </svg>
          </div>
          <div className="rounded-lg border">
            {rows.map((r, i) => (
              <div key={r.name} className={`flex items-center gap-2 px-3 py-2 text-[11px] ${i > 0 ? "border-t" : ""}`}>
                <PlatformIcon platform={r.p} size="xs" />
                <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                <span className="tabular">{r.spend}</span>
                <span className="w-10 text-right text-muted-foreground tabular">{r.roas}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
