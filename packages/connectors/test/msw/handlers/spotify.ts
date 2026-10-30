/**
 * Spotify Ads API v3 + Spotify Accounts service, as MSW handlers.
 *
 * Sources:
 *  - Token endpoint (authorization code + refresh, Basic client auth, `refresh_token` may be omitted on refresh):
 *    https://developer.spotify.com/documentation/web-api/tutorials/code-flow
 *    https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
 *  - Ads API v3 OpenAPI spec (base https://api-partner.spotify.com/ads/v3, `GET /businesses`,
 *    `GET /businesses/{business_id}/ad_accounts`, `limit`/`offset` list params, `Paging`
 *    {page_size,total_results,offset,current_page}, `PATCH /ad_accounts/{id}/campaigns/{id}`,
 *    `PATCH /ad_accounts/{id}/ad_sets/{id}`, ad set budget {micro_amount,type:"DAILY",currency}):
 *    https://developer.spotify.com/reference/ads-api/v3/api.yaml
 *  - Ad set budget in micros ($250 → 250000000): https://developer.spotify.com/documentation/ads-api/reference/v2.0/updateAdSet
 */
import { http, HttpResponse } from "msw";

export const SPOTIFY_API = "https://api-partner.spotify.com/ads/v3";
export const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";

type Row = Record<string, unknown>;

export interface SpotifyData {
  businesses: Row[];
  /** business id → ad accounts */
  adAccounts: Record<string, Row[]>;
  campaigns: Row[];
  adSets: Row[];
  ads: Row[];
}

export const spotifyData = (over: Partial<SpotifyData> = {}): SpotifyData => ({
  businesses: [{ id: "biz-1", name: "Ashniva Music" }], // unverified: business object field names (schema not in the fetched spec excerpt)
  adAccounts: {
    "biz-1": [
      { id: "acc-1", name: "Ashniva IN", currency_code: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" }, // unverified: ad account field names
    ],
  },
  campaigns: [{ id: "c1", name: "Festive audio", status: "ACTIVE", objective: "CLICKS", start_date: "2026-10-01T00:00:00Z", end_date: null }],
  adSets: [{ id: "s1", campaign_id: "c1", name: "IN music", status: "PAUSED", budget: { micro_amount: 25_500_000, type: "DAILY", currency: "INR" }, bid_strategy: "MAX_BID" }],
  ads: [{ id: "ad1", ad_set_id: "s1", campaign_id: "c1", name: "30s spot", status: "ACTIVE", format: "AUDIO", assets: { headline: "Diwali sale", tagline: "Up to 50% off", click_url: "https://shop.example.com" } }],
  ...over,
});

/** Paged list per the v3 spec: `limit` (default 50, unverified) + `offset`, with a `paging` object. */
function paged(key: string, rows: Row[], url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50); // unverified: default page size
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const page = rows.slice(offset, offset + limit);
  return HttpResponse.json({
    [key]: page,
    paging: { page_size: limit, total_results: rows.length, offset, current_page: Math.floor(offset / limit) + 1 },
  });
}

let seq = 0;

export function spotifyHandlers(data: SpotifyData = spotifyData()) {
  return [
    http.post(SPOTIFY_TOKEN, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "refresh_token") {
        // Refresh: a new refresh token "might" be returned; Spotify often leaves it out.
        return HttpResponse.json({ access_token: "sp-access-2", token_type: "Bearer", scope: "", expires_in: 3600 });
      }
      return HttpResponse.json({ access_token: "sp-access-1", token_type: "Bearer", scope: "", expires_in: 3600, refresh_token: "sp-refresh-1" });
    }),
    http.get(`${SPOTIFY_API}/businesses`, () => HttpResponse.json({ businesses: data.businesses })), // unverified: envelope key "businesses"
    http.get(`${SPOTIFY_API}/businesses/:id/ad_accounts`, ({ params, request }) => paged("ad_accounts", data.adAccounts[String(params.id)] ?? [], new URL(request.url))), // unverified: key "ad_accounts"
    http.get(`${SPOTIFY_API}/ad_accounts/:acc/campaigns`, ({ request }) => paged("campaigns", data.campaigns, new URL(request.url))),
    http.get(`${SPOTIFY_API}/ad_accounts/:acc/ad_sets`, ({ request }) => paged("ad_sets", data.adSets, new URL(request.url))),
    http.get(`${SPOTIFY_API}/ad_accounts/:acc/ads`, ({ request }) => paged("ads", data.ads, new URL(request.url))),
    http.patch(`${SPOTIFY_API}/ad_accounts/:acc/campaigns/:id`, ({ params }) => HttpResponse.json({ id: params.id })),
    http.patch(`${SPOTIFY_API}/ad_accounts/:acc/ad_sets/:id`, ({ params }) => HttpResponse.json({ id: params.id })),
    // Create endpoints return the created object with its id. unverified: exact create response body
    http.post(`${SPOTIFY_API}/ad_accounts/:acc/campaigns`, () => HttpResponse.json({ id: `new-c${++seq}` }, { status: 201 })),
    http.post(`${SPOTIFY_API}/ad_accounts/:acc/ad_sets`, () => HttpResponse.json({ id: `new-s${++seq}` }, { status: 201 })),
    http.post(`${SPOTIFY_API}/ad_accounts/:acc/ads`, () => HttpResponse.json({ id: `new-a${++seq}` }, { status: 201 })),
  ];
}
