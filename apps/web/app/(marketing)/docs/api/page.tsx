import { BRAND } from "@ashniva/shared";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "API reference" };

const ENDPOINTS = [
  {
    method: "GET",
    path: "/api/v1/workspaces",
    description: "Lists the workspaces in your organization.",
    example: `{
  "data": [
    { "id": "cmux…", "name": "Acme Retail", "currency": "INR", "timezone": "Asia/Kolkata" }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/{workspaceId}/campaigns?from=2026-10-01&to=2026-10-07",
    description: "Campaigns with totals for the date range. Optional filters: platform (META, GOOGLE, …) and status (ACTIVE, PAUSED).",
    example: `{
  "range": { "from": "2026-10-01", "to": "2026-10-07" },
  "data": [
    {
      "id": "cmux…", "platform": "META", "name": "Festive Sale – Prospecting",
      "status": "ACTIVE", "dailyBudget": 18000, "currency": "INR",
      "metrics": { "spend": 132400.5, "impressions": 802311, "clicks": 11240,
                   "conversions": 322, "conversionValue": 497300, "ctr": 0.014,
                   "cpc": 11.78, "cpa": 411.18, "roas": 3.76 }
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/{workspaceId}/metrics?from=2026-10-01&to=2026-10-07",
    description: "Daily totals across all ad accounts in the workspace. Add campaignId to get one campaign.",
    example: `{
  "range": { "from": "2026-10-01", "to": "2026-10-07" },
  "data": [
    { "date": "2026-10-01", "impressions": 312004, "clicks": 3921, "spend": 101233.4,
      "conversions": 268.4, "conversionValue": 401220, "videoViews": 21033 }
  ]
}`,
  },
];

export default function ApiDocsPage() {
  return (
    <article className="mx-auto max-w-3xl px-5 py-16 sm:py-20">
      <header className="mb-10 border-b pb-8">
        <p className="text-sm font-semibold text-primary">Developers</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{BRAND.name} API</h1>
        <p className="mt-3 text-muted-foreground">
          A read-only REST API for pulling campaigns and performance into BI tools, data warehouses and your own scripts.
          Available on the Agency plan.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Authentication</h2>
        <p className="text-[15px] leading-7 text-foreground/85">
          Create a key in <strong>Settings → API keys</strong> and send it as a bearer token. Keys belong to an
          organization and can read every workspace in it.
        </p>
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
{`curl https://app.ashniva.com/api/v1/workspaces \\
  -H "Authorization: Bearer ak_live_…"`}
        </pre>
        <p className="text-sm text-muted-foreground">
          Rate limit: 120 requests per minute per key. Dates are <code>YYYY-MM-DD</code>; money is in each workspace&apos;s
          currency. Ratios (<code>ctr</code>, <code>conversionRate</code>) are fractions, so 0.014 means 1.4%.
        </p>
      </section>

      <section className="mt-12 space-y-8">
        <h2 className="text-lg font-semibold">Endpoints</h2>
        {ENDPOINTS.map((e) => (
          <div key={e.path} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-success/10 px-2 py-0.5 font-mono text-xs font-semibold text-success">{e.method}</span>
              <code className="font-mono text-sm break-all">{e.path}</code>
            </div>
            <p className="text-[15px] text-foreground/85">{e.description}</p>
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{e.example}</pre>
          </div>
        ))}
      </section>

      <section className="mt-12 space-y-3">
        <h2 className="text-lg font-semibold">Errors</h2>
        <p className="text-[15px] leading-7 text-foreground/85">
          Errors return a JSON body like <code>{`{ "error": { "code": "UNAUTHORIZED", "message": "…" } }`}</code>. Common
          codes: <code>401 UNAUTHORIZED</code> (missing or revoked key), <code>402 FEATURE_LOCKED</code> (plan doesn&apos;t include
          the API), <code>404 NOT_FOUND</code>, <code>422 VALIDATION_ERROR</code> and <code>429 RATE_LIMITED</code>.
        </p>
      </section>
    </article>
  );
}
