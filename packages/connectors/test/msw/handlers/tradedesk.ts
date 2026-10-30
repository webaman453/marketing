/**
 * The Trade Desk platform API v3 handlers.
 * Docs: https://partner.thetradedesk.com/v3/portal/api/doc (partner portal, login required)
 *  - Auth: every call carries the long-lived token in the `TTD-Auth` header.
 *  - Query endpoints (POST /v3/<entity>/query/<scope>) page with PageStartIndex/PageSize and answer
 *    { Result: [...], ResultCount, TotalFilteredCount, TotalUnfilteredCount }.  // unverified (portal not public; from memory)
 *  - Money is { Amount, CurrencyCode } in currency units, not micros.          // unverified
 *  - PUT /v3/adgroup and PUT /v3/campaign are partial updates keyed by AdGroupId / CampaignId. // unverified
 */
import { http, HttpResponse } from "msw";

export const TTD = "https://api.thetradedesk.com/v3";
type Row = Record<string, any>;

/** Serves one query endpoint from an in-memory list, paging like TTD does. */
export function ttdQuery(path: string, rows: Row[] | ((body: Row) => Row[]), opts: { total?: (all: Row[]) => number } = {}) {
  return http.post(`${TTD}${path}`, async ({ request }) => {
    const body = (await request.json()) as Row;
    const all = typeof rows === "function" ? rows(body) : rows;
    const start = Number(body.PageStartIndex ?? 0);
    const size = Number(body.PageSize ?? 100);
    const page = all.slice(start, start + size);
    return HttpResponse.json({ Result: page, ResultCount: page.length, TotalFilteredCount: opts.total ? opts.total(all) : all.length, TotalUnfilteredCount: all.length });
  });
}

export const advertiser = (i: number, over: Row = {}) => ({ AdvertiserId: `adv${i}`, AdvertiserName: `Advertiser ${i}`, PartnerId: "partner-1", CurrencyCode: "USD", ...over });

export const campaign = (id: string, over: Row = {}) => ({
  CampaignId: id,
  CampaignName: `Campaign ${id}`,
  AdvertiserId: "adv1",
  Availability: "Available",
  Budget: { Amount: 5000, CurrencyCode: "USD" },
  DailyBudget: { Amount: 250, CurrencyCode: "USD" },
  StartDate: "2026-10-01T00:00:00",
  EndDate: "2026-12-31T23:59:59",
  ...over,
});

export const adGroup = (id: string, campaignId: string, over: Row = {}) => ({
  AdGroupId: id,
  CampaignId: campaignId,
  AdGroupName: `Ad group ${id}`,
  IsEnabled: true,
  RTBAttributes: { BudgetSettings: { DailyBudget: { Amount: 40, CurrencyCode: "USD" } } },
  ...over,
});

/** Ad groups served from POST /adgroup/query/campaign, filtered by CampaignId. */
export const adGroupsByCampaign = (groups: Row[]) => ttdQuery("/adgroup/query/campaign", (body) => groups.filter((g) => g.CampaignId === body.CampaignId));

/** Create endpoints that hand back ids like TTD does (the created entity echoed with its new id). */
export function ttdCreate() {
  let n = 0;
  return [
    http.post(`${TTD}/campaign`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), CampaignId: `camp${++n}` })),
    http.post(`${TTD}/creative`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), CreativeId: `cr${++n}` })),
    http.post(`${TTD}/adgroup`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), AdGroupId: `ag${++n}` })),
  ];
}

export const ttdUpdates = () => [
  http.put(`${TTD}/adgroup`, async ({ request }) => HttpResponse.json(await request.json())),
  http.put(`${TTD}/campaign`, async ({ request }) => HttpResponse.json(await request.json())),
];
