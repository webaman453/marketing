/**
 * Yahoo DSP Traffic API, as MSW handlers.
 *
 * Sources (Yahoo moved the docs from developer.yahooinc.com to help.yahooinc.com):
 *  - Campaigns: https://help.yahooinc.com/dsp-api/docs/campaigns
 *    `GET /traffic/campaigns?accountId=…&page=&limit=` (limit max 100); envelope {response, errors, timeStamp};
 *    status ACTIVE | PAUSED | INACTIVE; `accountId` on the campaign; budgets live in `budgetSchedules`.
 *  - Lines: https://help.yahooinc.com/dsp-api/docs/lines
 *    `GET /traffic/lines?orderId=<campaign id>&page=&limit=`; the line's parent field is `orderId`;
 *    mediaType DISPLAY | VIDEO | AUDIO; a line cannot be created ACTIVE.
 *  - OAuth 2 (authorization code on api.login.yahoo.com): https://developer.yahoo.com/oauth2/guide/flows_authcode/
 *    // unverified: the DSP setup guide may require the client-credentials JWT flow instead.
 */
import { http, HttpResponse } from "msw";

export const YAHOO_API = "https://dspapi.admanagerplus.yahoo.com/traffic";
export const YAHOO_TOKEN = "https://api.login.yahoo.com/oauth2/get_token";

type Row = Record<string, unknown>;

export interface YahooData {
  advertisers: Row[];
  campaigns: Row[];
  lines: Row[];
  ads: Row[];
}

export const yahooData = (over: Partial<YahooData> = {}): YahooData => ({
  advertisers: [{ id: 7001, name: "Ashniva Retail", currency: "USD", timezone: "America/New_York", status: "ACTIVE" }], // unverified: advertiser fields
  campaigns: [{ id: 501, accountId: 7001, name: "Festive display", status: "ACTIVE", goalType: "CPC", budget: 40, startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-31T00:00:00Z" }],
  lines: [{ id: 601, orderId: 501, campaignId: 501, name: "IN desktop", status: "PAUSED", budget: 20, bidPrice: 2.5, mediaType: "DISPLAY" }],
  ads: [{ id: 701, lineId: 601, campaignId: 501, name: "300x250", status: "ACTIVE", title: "Sale", description: "Up to 50%", landingPageUrl: "https://shop.example.com", adType: "DISPLAY" }], // unverified: ad fields
  ...over,
});

const env = (response: unknown) => HttpResponse.json({ response, errors: null, timeStamp: "2026-10-15T10:00:00Z" });

/** List with page (1-based) + limit (max 100), per the Campaigns/Lines docs. */
function list(rows: Row[], url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 100); // unverified: default when limit is absent
  const page = Number(url.searchParams.get("page") ?? 1);
  return env(rows.slice((page - 1) * limit, page * limit));
}

let seq = 0;

export function yahooHandlers(data: YahooData = yahooData()) {
  return [
    http.post(YAHOO_TOKEN, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const refresh = form.get("grant_type") === "refresh_token";
      return HttpResponse.json({ access_token: refresh ? "yh-access-2" : "yh-access-1", refresh_token: refresh ? undefined : "yh-refresh-1", expires_in: 3600, token_type: "bearer" });
    }),
    http.get(`${YAHOO_API}/advertisers`, ({ request }) => list(data.advertisers, new URL(request.url))),
    http.get(`${YAHOO_API}/campaigns`, ({ request }) => {
      const url = new URL(request.url);
      const acc = url.searchParams.get("accountId") ?? url.searchParams.get("advertiserId");
      return list(data.campaigns.filter((c) => !acc || String(c.accountId) === acc), url);
    }),
    http.get(`${YAHOO_API}/lines`, ({ request }) => list(data.lines, new URL(request.url))),
    http.get(`${YAHOO_API}/ads`, ({ request }) => list(data.ads, new URL(request.url))),
    http.put(`${YAHOO_API}/campaigns/:id`, ({ params }) => env({ id: Number(params.id) })),
    http.post(`${YAHOO_API}/campaigns`, () => env({ id: 9000 + ++seq })),
    http.post(`${YAHOO_API}/lines`, () => env({ id: 9100 + ++seq })),
    http.post(`${YAHOO_API}/ads`, () => env({ id: 9200 + ++seq })),
  ];
}
