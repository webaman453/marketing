/**
 * Snapchat Marketing API v1 mock handlers.
 *
 * Shapes follow the official docs:
 *  - OAuth:            https://developers.snap.com/api/marketing-api/Ads-API/authentication
 *  - Me / orgs:        https://developers.snap.com/api/marketing-api/Ads-API/user
 *                      https://developers.snap.com/api/marketing-api/Ads-API/organizations
 *  - Campaigns:        https://developers.snap.com/api/marketing-api/Ads-API/campaigns
 *  - Ad squads:        https://developers.snap.com/api/marketing-api/Ads-API/ad-squads
 *  - Ads / creatives:  https://developers.snap.com/api/marketing-api/Ads-API/ads
 *                      https://developers.snap.com/api/marketing-api/Ads-API/creatives
 *  - Media:            https://developers.snap.com/api/marketing-api/Ads-API/media
 *  - Stats:            https://developers.snap.com/api/marketing-api/Ads-API/measurement
 *  - Paging:           https://developers.snap.com/api/marketing-api/Ads-API/pagination
 * Every response is wrapped as { request_status, request_id, <key>: [{ sub_request_status, <entity> }] }.
 */
import { http, HttpResponse } from "../server";

export const SNAP_API = "https://adsapi.snapchat.com/v1";
export const SNAP_TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";

type Row = Record<string, any>;

/** Wraps entities the way every Snap list/create response does. */
export const snapWrap = (key: string, entity: string, items: Row[], extra: Row = {}) => ({
  request_status: "SUCCESS",
  request_id: "req-1",
  ...extra,
  [key]: items.map((item) => ({ sub_request_status: "SUCCESS", [entity]: item })),
});

/** Token endpoint: authorization_code and refresh_token grants. Snap access tokens live 1800s. */
export const snapToken = (body: Row = {}) =>
  http.post(SNAP_TOKEN_URL, () =>
    HttpResponse.json({
      access_token: "snap-access",
      token_type: "Bearer",
      expires_in: 1800,
      refresh_token: "snap-refresh-2",
      scope: "snapchat-marketing-api",
      ...body,
    }),
  );

export const snapMe = () =>
  http.get(`${SNAP_API}/me`, () =>
    HttpResponse.json({
      request_status: "SUCCESS",
      request_id: "req-me",
      me: { id: "user-1", updated_at: "2026-01-01T00:00:00.000Z", email: "ads@example.com", organization_id: "org-1", display_name: "Asha Rao", member_status: "MEMBER" },
    }),
  );

export const snapOrganizations = () =>
  http.get(`${SNAP_API}/me/organizations`, () =>
    HttpResponse.json(
      snapWrap("organizations", "organization", [
        {
          id: "org-1",
          name: "Asha Org",
          type: "ENTERPRISE",
          ad_accounts: [
            { id: "acc-1", name: "Main", type: "PARTNER", status: "ACTIVE", organization_id: "org-1", currency: "USD", timezone: "America/Los_Angeles" },
            { id: "acc-2", name: "India", type: "DIRECT", status: "PAUSED", organization_id: "org-1", currency: "INR", timezone: "Asia/Kolkata" },
          ],
        },
        // An organization without ad accounts lists none.
        { id: "org-2", name: "Empty" },
      ]),
    ),
  );

/**
 * A paged list: `pages[i]` are the entities on page i; page i links to page i+1
 * via `paging.next_link` (a full URL, per the pagination docs).
 */
export function snapPagedList(path: string, key: string, entity: string, pages: Row[][]) {
  return http.get(`${SNAP_API}${path}`, ({ request }) => {
    const u = new URL(request.url);
    const page = Number(u.searchParams.get("page") ?? 0);
    const items = pages[page] ?? [];
    const next = page + 1 < pages.length ? `${SNAP_API}${path}?cursor=c${page + 1}&page=${page + 1}&limit=1000` : undefined;
    return HttpResponse.json(snapWrap(key, entity, items, next ? { paging: { next_link: next } } : { paging: {} }));
  });
}

export const SNAP_CAMPAIGN = {
  id: "camp-1",
  updated_at: "2026-10-01T12:00:00.000Z",
  created_at: "2026-09-01T12:00:00.000Z",
  name: "Diwali",
  ad_account_id: "acc-1",
  status: "ACTIVE",
  objective: "BRAND_AWARENESS",
  start_time: "2026-10-01T07:00:00.000Z",
  end_time: "2026-11-15T07:59:59.000Z",
  daily_budget_micro: 25_500_000,
  lifetime_spend_cap_micro: 1_000_000_000,
  delivery_status: ["VALID"],
};

/** Stats with a DAY timeseries per entity in `breakdown_stats[breakdown]`. Spend is in micro-currency. */
export function snapStatsBody(breakdown: string, entities: { id: string; days: { start: string; stats: Row }[] }[]) {
  return {
    request_status: "SUCCESS",
    request_id: "req-stats",
    timeseries_stats: [
      {
        sub_request_status: "SUCCESS",
        timeseries_stat: {
          id: "acc-1",
          type: "AD_ACCOUNT",
          granularity: "DAY",
          breakdown_stats: {
            [breakdown]: entities.map((e) => ({
              id: e.id,
              type: breakdown.toUpperCase(),
              granularity: "DAY",
              timeseries: e.days.map((d) => ({ start_time: d.start, end_time: d.start, stats: d.stats })),
            })),
          },
        },
      },
    ],
  };
}

/** Create endpoints echo the entity back with a fresh id. */
export function snapCreate(path: string | RegExp, key: string, entity: string, idPrefix: string) {
  let n = 0;
  return http.post(typeof path === "string" ? `${SNAP_API}${path}` : path, async ({ request }) => {
    const body = (await request.json()) as Row;
    const items = (body[key] as Row[]).map((item) => ({ ...item, id: `${idPrefix}-${++n}` }));
    return HttpResponse.json(snapWrap(key, entity, items));
  });
}

/** Every handler a successful createCampaign needs (media goes straight to READY). */
export function snapCreateHandlers() {
  return [
    snapCreate(/\/v1\/adaccounts\/[^/]+\/campaigns$/, "campaigns", "campaign", "camp"),
    snapCreate(/\/v1\/campaigns\/[^/]+\/adsquads$/, "adsquads", "adsquad", "squad"),
    snapCreate(/\/v1\/adaccounts\/[^/]+\/media$/, "media", "media", "media"),
    http.post(/\/v1\/media\/[^/]+\/upload$/, async ({ request }) => {
      // Read the multipart body before answering so the upload stream isn't cut off.
      await request.arrayBuffer();
      return HttpResponse.json({ request_status: "SUCCESS", result: { duration_in_seconds: 0 } });
    }),
    http.get(/\/v1\/media\/[^/]+$/, ({ request }) => {
      const id = new URL(request.url).pathname.split("/").pop();
      return HttpResponse.json(snapWrap("media", "media", [{ id, media_status: "READY" }]));
    }),
    snapCreate(/\/v1\/adaccounts\/[^/]+\/creatives$/, "creatives", "creative", "cre"),
    snapCreate(/\/v1\/adsquads\/[^/]+\/ads$/, "ads", "ad", "ad"),
    http.delete(/\/v1\/campaigns\/[^/]+$/, () => HttpResponse.json({ request_status: "SUCCESS" })),
  ];
}

/** A Snap error body (shape from the docs' error section). */
export const snapError = (msg = "Invalid access token") => ({ request_status: "ERROR", request_id: "req-err", debug_message: msg, display_message: msg, error_code: "E1001" }); // unverified: error_code value
