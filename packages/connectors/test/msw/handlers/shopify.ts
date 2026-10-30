/**
 * Shopify OAuth + Admin REST API, as MSW handlers.
 *
 * Sources:
 *  - Authorization code grant, callback `hmac` (HMAC-SHA256 hex of the sorted query minus hmac),
 *    token request {client_id, client_secret, code} → {access_token, scope}:
 *    https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 *  - Expiring offline tokens: {access_token, expires_in, refresh_token, refresh_token_expires_in, scope},
 *    refresh with grant_type=refresh_token:
 *    https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens
 *  - Shop resource (myshopify_domain, currency, iana_timezone): https://shopify.dev/docs/api/admin-rest/latest/resources/shop
 *  - MarketingEvent resource (event_type, marketing_channel, paid, budget as string, budget_type daily|lifetime,
 *    utm_*, started_at, ended_at, referring_domain): https://shopify.dev/docs/api/admin-rest/latest/resources/marketingevent
 *  - Cursor pagination via `Link: <…page_info=…>; rel="next"`: https://shopify.dev/docs/api/admin-rest/usage/pagination
 */
import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";

export const SHOP = "festive-store.myshopify.com";
export const SHOPIFY_SECRET = "shpss_test_secret";
export const SHOPIFY_VERSION = "2026-04";
export const shopAdmin = (shop = SHOP) => `https://${shop}/admin/api/${SHOPIFY_VERSION}`;

type Row = Record<string, unknown>;

/** A signed-state lookalike: header.payload.signature with the shop in the payload (what the API's state JWT carries). */
export const shopState = (shop: unknown = SHOP) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ shop, orgId: "org-1" })).toString("base64url")}.sig`;

/** Signs a callback query the way Shopify does. */
export function signQuery<Q extends Record<string, string>>(query: Q, secret = SHOPIFY_SECRET): Q & { hmac: string } {
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&");
  return { ...query, hmac: createHmac("sha256", secret).update(message).digest("hex") };
}

export const shopRow = (over: Row = {}): Row => ({
  id: 548380009,
  name: "Festive Store",
  myshopify_domain: SHOP,
  currency: "INR",
  iana_timezone: "Asia/Kolkata",
  ...over,
});

export const marketingEvent = (id: number, over: Row = {}): Row => ({
  id,
  event_type: "ad",
  marketing_channel: "social",
  paid: true,
  budget: "12.50",
  budget_type: "daily",
  currency: "INR",
  utm_campaign: `Campaign ${id}`,
  utm_source: "facebook",
  utm_medium: "cpc",
  description: `Event ${id} description`,
  referring_domain: "shop.example.com",
  started_at: "2026-10-01T00:00:00+05:30",
  ended_at: null,
  ...over,
});

/**
 * Marketing events served in pages of `pageSize`, linked with Link rel="next".
 * Set `endlessPages` to simulate a list that never ends (cap test).
 */
export function shopifyHandlers(opts: { events?: Row[]; pageSize?: number; endlessPages?: boolean; shop?: Row; token?: Row } = {}) {
  const events = opts.events ?? [marketingEvent(1)];
  const pageSize = opts.pageSize ?? 250;
  const base = shopAdmin();
  return [
    http.post(`https://${SHOP}/admin/oauth/access_token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "refresh_token") return HttpResponse.json({ access_token: "shpat_new", expires_in: 3600, scope: "write_marketing_events" });
      return HttpResponse.json(opts.token ?? { access_token: "shpat_abc", scope: "write_marketing_events" });
    }),
    http.get(`${base}/shop.json`, () => HttpResponse.json({ shop: opts.shop ?? shopRow() })),
    http.get(`${base}/marketing_events.json`, ({ request }) => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get("page_info")?.replace("p", "") ?? 0);
      const rows = opts.endlessPages ? [marketingEvent(page + 1)] : events.slice(page * pageSize, (page + 1) * pageSize);
      const more = opts.endlessPages || (page + 1) * pageSize < events.length;
      const headers: Record<string, string> = {};
      // Next-page links carry only limit + page_info.
      if (more) headers.Link = `<${base}/marketing_events.json?limit=${pageSize}&page_info=p${page + 1}>; rel="next"`;
      return HttpResponse.json({ marketing_events: rows }, { headers });
    }),
    http.put(`${base}/marketing_events/:id.json`, async ({ request, params }) => HttpResponse.json({ marketing_event: { id: Number(params.id), ...((await request.json()) as { marketing_event: Row }).marketing_event } })),
    http.post(`${base}/marketing_events.json`, async ({ request }) => HttpResponse.json({ marketing_event: { id: 998730395, ...((await request.json()) as { marketing_event: Row }).marketing_event } }, { status: 201 })),
  ];
}
