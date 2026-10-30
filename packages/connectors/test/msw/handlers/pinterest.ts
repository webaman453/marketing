/**
 * Pinterest API v5 mock handlers.
 *
 * Shapes follow the official docs:
 *  - OAuth token:   https://developers.pinterest.com/docs/api/v5/oauth-token/
 *                   https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/
 *  - User account:  https://developers.pinterest.com/docs/api/v5/user_account-get/
 *  - Ad accounts:   https://developers.pinterest.com/docs/api/v5/ad_accounts-list/
 *  - Campaigns:     https://developers.pinterest.com/docs/api/v5/campaigns-list/ (and -create, -update)
 *  - Ad groups:     https://developers.pinterest.com/docs/api/v5/ad_groups-list/ (and -create)
 *  - Ads:           https://developers.pinterest.com/docs/api/v5/ads-list/ (and -create)
 *  - Analytics:     https://developers.pinterest.com/docs/api/v5/campaigns-analytics/
 *  - Pins/boards:   https://developers.pinterest.com/docs/api/v5/pins-create/ , boards-create/
 *  - Media upload:  https://developers.pinterest.com/docs/api/v5/media-create/
 *  - Keywords:      https://developers.pinterest.com/docs/api/v5/keywords-create/
 * Lists are { items, bookmark }; bulk writes answer { items: [{ data, exceptions }] }.
 */
import { http, HttpResponse } from "../server";

export const PIN_API = "https://api.pinterest.com/v5";

type Row = Record<string, any>;

/** Authorization code response (30-day access token, 1-year refresh token). */
export const pinToken = (body: Row = {}) =>
  http.post(`${PIN_API}/oauth/token`, () =>
    HttpResponse.json({
      access_token: "pina_access",
      refresh_token: "pinr_refresh",
      response_type: "authorization_code",
      token_type: "bearer",
      expires_in: 2_592_000,
      refresh_token_expires_in: 31_536_000,
      scope: "ads:read,ads:write,user_accounts:read",
      ...body,
    }),
  );

/** Refresh response: per the docs a refresh_token is only returned with continuous refresh. */
export const pinRefresh = () =>
  http.post(`${PIN_API}/oauth/token`, () =>
    HttpResponse.json({ access_token: "pina_access_2", token_type: "bearer", expires_in: 2_592_000, scope: "ads:read,ads:write" }),
  );

export const pinUser = (body: Row = {}) =>
  http.get(`${PIN_API}/user_account`, () =>
    HttpResponse.json({ account_type: "BUSINESS", id: "user-9", username: "ashastudio", business_name: "Asha Studio", website_url: "https://asha.example", ...body }),
  );

/** A bookmark-paged list: page i answers items pages[i] and a bookmark to page i+1. */
export function pinPagedList(path: string, pages: Row[][]) {
  return http.get(`${PIN_API}${path}`, ({ request }) => {
    const bm = new URL(request.url).searchParams.get("bookmark");
    const page = bm ? Number(bm.replace("bm-", "")) : 0;
    return HttpResponse.json({ items: pages[page] ?? [], bookmark: page + 1 < pages.length ? `bm-${page + 1}` : null });
  });
}

export const PIN_CAMPAIGN = {
  id: "626736533506",
  ad_account_id: "549755885175",
  name: "Festive decor",
  status: "ACTIVE",
  lifetime_spend_cap: 5_000_000_000,
  daily_spend_cap: 12_340_000,
  start_time: 1_759_276_800, // 2025-10-01T00:00:00Z
  end_time: 1_761_955_200, // 2025-11-01T00:00:00Z
  summary_status: "RUNNING",
  objective_type: "CONSIDERATION",
  created_time: 1_759_000_000,
  updated_time: 1_759_276_800,
  type: "campaign",
  is_campaign_budget_optimization: false,
};

/** Bulk write echo: { items: [{ data: { ...input, id }, exceptions: [] }] }. */
export function pinBulk(method: "post" | "patch", path: string | RegExp, idPrefix: string) {
  let n = 0;
  return http[method](typeof path === "string" ? `${PIN_API}${path}` : path, async ({ request }) => {
    const body = (await request.json()) as Row[];
    return HttpResponse.json({ items: body.map((item) => ({ data: { ...item, id: item.id ?? `${idPrefix}-${++n}` }, exceptions: [] })) });
  });
}

/** Every handler a successful createCampaign needs. */
export function pinCreateHandlers() {
  let pins = 0;
  return [
    pinBulk("post", /\/v5\/ad_accounts\/[^/]+\/campaigns$/, "camp"),
    pinBulk("patch", /\/v5\/ad_accounts\/[^/]+\/campaigns$/, "camp"),
    pinBulk("post", /\/v5\/ad_accounts\/[^/]+\/ad_groups$/, "group"),
    pinBulk("post", /\/v5\/ad_accounts\/[^/]+\/ads$/, "ad"),
    http.post(/\/v5\/ad_accounts\/[^/]+\/keywords$/, async ({ request }) => {
      const body = (await request.json()) as Row;
      return HttpResponse.json({ keywords: body.keywords.map((k: Row, i: number) => ({ ...k, id: `kw-${i}`, parent_id: body.parent_id })), exceptions: [] });
    }),
    http.get(`${PIN_API}/boards`, () => HttpResponse.json({ items: [{ id: "board-old", name: "Ashniva Ads", privacy: "SECRET" }], bookmark: null })),
    http.post(`${PIN_API}/boards`, () => HttpResponse.json({ id: "board-new", name: "Ashniva Ads", privacy: "SECRET" })),
    http.post(`${PIN_API}/pins`, () => HttpResponse.json({ id: `pin-${++pins}`, board_id: "board-old", created_at: "2026-10-01T00:00:00" })),
    http.post(`${PIN_API}/media`, () =>
      HttpResponse.json({ media_id: "12345", media_type: "video", upload_url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/", upload_parameters: { key: "uploads/x.mp4", policy: "p", "x-amz-signature": "s" } }),
    ),
    // S3 presigned POST (fields from upload_parameters, then `file`). Read the body before answering.
    http.post("https://pinterest-media-upload.s3-accelerate.amazonaws.com/", async ({ request }) => {
      await request.arrayBuffer();
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${PIN_API}/media/:id`, ({ params }) => HttpResponse.json({ media_id: params.id, media_type: "video", status: "succeeded" })),
  ];
}

/** Pinterest error body: { code, message }. */
export const pinError = (message = "Authentication failed.", code = 2) => ({ code, message });
