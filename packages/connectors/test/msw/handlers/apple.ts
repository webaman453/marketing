/**
 * Apple Search Ads Campaign Management API v5 handlers.
 * Docs: https://developer.apple.com/documentation/apple_ads
 *  - Token: POST https://appleid.apple.com/auth/oauth2/token, form grant_type=client_credentials, client_id,
 *    client_secret (ES256 JWT), scope=searchadsorg → { access_token, token_type: "Bearer", expires_in: 3600 }
 *    (https://developer.apple.com/documentation/apple_ads/implementing-oauth-for-the-apple-search-ads-api)
 *  - GET /api/v5/acls → { data: [{ orgName, orgId, currency, paymentModel, roleNames, timeZone }] }
 *    (https://developer.apple.com/documentation/apple_ads/get-user-acl)
 *  - Lists take ?offset&limit (limit ≤ 1000) and answer { data, pagination: { totalResults, startIndex, itemsPerPage } }
 *    (https://developer.apple.com/documentation/apple_ads/pagedetail)
 *  - Every org call carries `X-AP-Context: orgId=<id>`.
 *  - Money is { amount: "<decimal string>", currency } in currency units (https://developer.apple.com/documentation/apple_ads/money)
 *  - PUT /campaigns/{id} takes { campaign: { ...changed fields } } (https://developer.apple.com/documentation/apple_ads/updatecampaignrequest)
 *  - POST /reports/campaigns → { data: { reportingDataResponse: { row: [{ metadata: { campaignId, ... }, granularity: [SpendRow & { date }] }] } } }
 *    SpendRow fields: impressions, taps, tapInstalls, viewInstalls, totalInstalls, localSpend, ... (no `installs`)
 *    (https://developer.apple.com/documentation/apple_ads/spendrow)
 */
import { http, HttpResponse } from "msw";

export const APPLE_TOKEN = "https://appleid.apple.com/auth/oauth2/token";
export const AP = "https://api.searchads.apple.com/api/v5";
type Row = Record<string, any>;

export const apToken = (body: Row = { access_token: "ap-access", token_type: "Bearer", expires_in: 3600 }) => http.post(APPLE_TOKEN, () => HttpResponse.json(body));

export const acl = (orgId: number, over: Row = {}) => ({ orgName: `Org ${orgId}`, orgId, currency: "USD", paymentModel: "PAYG", roleNames: ["API Campaign Manager"], timeZone: "America/Los_Angeles", ...over });

export const apCampaign = (id: number, over: Row = {}) => ({
  id,
  orgId: 40669820,
  name: `Campaign ${id}`,
  adamId: 1234567890,
  status: "ENABLED",
  servingStatus: "RUNNING",
  adChannelType: "SEARCH",
  dailyBudgetAmount: { amount: "50.00", currency: "USD" },
  budgetAmount: { amount: "1000.5", currency: "USD" },
  startTime: "2026-10-01T00:00:00.000",
  endTime: "2026-12-31T00:00:00.000",
  countriesOrRegions: ["US"],
  ...over,
});

export const apAdGroup = (id: number, campaignId: number, over: Row = {}) => ({ id, campaignId, name: `Ad group ${id}`, status: "ENABLED", pricingModel: "CPC", defaultBidAmount: { amount: "1.5", currency: "USD" }, ...over });

export const apAd = (id: number, over: Row = {}) => ({ id, name: `Ad ${id}`, creativeType: "CUSTOM_PRODUCT_PAGE", status: "ENABLED", ...over });

/** A v5 list endpoint served with offset/limit paging. */
export const apList = (path: string, rows: Row[] | ((params: Record<string, string>) => Row[])) =>
  http.get(`${AP}${path}`, ({ request, params }) => {
    const all = typeof rows === "function" ? rows(params as Record<string, string>) : rows;
    const q = new URL(request.url).searchParams;
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 20);
    const page = all.slice(offset, offset + limit);
    return HttpResponse.json({ data: page, pagination: { totalResults: all.length, startIndex: offset, itemsPerPage: page.length } });
  });

export function apCreate() {
  let n = 100;
  return [
    http.post(`${AP}/campaigns`, async ({ request }) => HttpResponse.json({ data: { ...((await request.json()) as Row), id: ++n } })),
    http.post(`${AP}/campaigns/:cid/adgroups`, async ({ request, params }) => HttpResponse.json({ data: { ...((await request.json()) as Row), id: ++n, campaignId: Number(params.cid) } })),
    http.post(`${AP}/campaigns/:cid/adgroups/:gid/targetingkeywords/bulk`, async ({ request }) => HttpResponse.json({ data: ((await request.json()) as Row[]).map((k, i) => ({ ...k, id: 500 + i })) })),
    http.post(`${AP}/creatives`, async ({ request }) => HttpResponse.json({ data: { ...((await request.json()) as Row), id: ++n } })),
    http.post(`${AP}/campaigns/:cid/adgroups/:gid/ads`, async ({ request }) => HttpResponse.json({ data: { ...((await request.json()) as Row), id: ++n } })),
    http.put(`${AP}/campaigns/:cid`, async ({ request }) => HttpResponse.json({ data: ((await request.json()) as Row).campaign })),
    http.put(`${AP}/campaigns/:cid/adgroups/:gid`, async ({ request }) => HttpResponse.json({ data: await request.json() })),
  ];
}
