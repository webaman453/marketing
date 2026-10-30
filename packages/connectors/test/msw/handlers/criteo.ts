/**
 * Criteo Marketing Solutions API handlers.
 * Docs: https://developers.criteo.com/marketing-solutions/docs
 *  - Token: POST https://api.criteo.com/oauth2/token, form grant_type=client_credentials, client_id, client_secret →
 *    { access_token, token_type: "Bearer", expires_in: 900 }   // expires_in value from memory: unverified
 *  - Advertisers: GET /{version}/advertisers/me → { data: [{ id, type: "Advertiser", attributes: { advertiserName } }] }
 *    (https://developers.criteo.com/marketing-solutions/reference/advertiser/2026-01advertisersme.md)
 *  - Ad sets (https://developers.criteo.com/marketing-solutions/docs/ad-set):
 *      POST /{version}/marketing-solutions/ad-sets/search  { filters: { advertiserIds: [...] } }
 *      POST /{version}/marketing-solutions/ad-sets/start | /stop  { data: [{ type: "AdSetId", id }] }
 *      PATCH /{version}/marketing-solutions/ad-sets  { data: [{ type: "PatchAdSet", id, attributes }] }
 *
 * The connector currently calls other paths (GET /advertisers, GET /advertisers/{id}/ad-sets,
 * PATCH /ad-sets/{id}, POST /advertisers/{id}/ad-sets, POST /ad-sets/{id}/ads). Those are served by
 * `criteoLegacy*` below so the connector's own logic can be tested; they are NOT in Criteo's docs.  // unverified
 */
import { http, HttpResponse } from "msw";

export const CRITEO_TOKEN = "https://api.criteo.com/oauth2/token";
export const CR = "https://api.criteo.com/2025-10";
type Row = Record<string, any>;

export const crToken = (body: Row = { access_token: "cr-access", token_type: "Bearer", expires_in: 900 }) => http.post(CRITEO_TOKEN, () => HttpResponse.json(body));

export const crAdvertiser = (id: string, over: Row = {}) => ({ id, type: "Advertiser", attributes: { advertiserName: `Advertiser ${id}`, ...over } });

export const crAdSet = (id: string, campaignId: string, over: Row = {}) => ({
  id,
  type: "AdSet",
  attributes: { name: `Ad set ${id}`, advertiserId: "adv1", campaignId, status: "ACTIVE", budget: { amount: 30, type: "DAILY" }, bidding: { type: "CPC" }, ...over },
});

/** Documented: GET /advertisers/me. */
export const crAdvertisersMe = (list: Row[]) => http.get(`${CR}/advertisers/me`, () => HttpResponse.json({ data: list, warnings: [], errors: [] }));

/** Documented: POST /marketing-solutions/ad-sets/search. */
export const crAdSetSearch = (list: Row[]) =>
  http.post(`${CR}/marketing-solutions/ad-sets/search`, async ({ request }) => {
    const ids: string[] = ((await request.json()) as Row)?.filters?.advertiserIds ?? [];
    return HttpResponse.json({ data: list.filter((s) => !ids.length || ids.includes(s.attributes.advertiserId)), warnings: [], errors: [] });
  });

/** Documented: POST /marketing-solutions/ad-sets/start|stop. */
export const crStartStop = () => [
  http.post(`${CR}/marketing-solutions/ad-sets/stop`, async ({ request }) => HttpResponse.json({ data: ((await request.json()) as Row).data, errors: [] })),
  http.post(`${CR}/marketing-solutions/ad-sets/start`, async ({ request }) => HttpResponse.json({ data: ((await request.json()) as Row).data, errors: [] })),
];

// ── Paths the connector uses today (not documented; see header). ──

export const crLegacyAdvertisers = (list: Row[]) => http.get(`${CR}/advertisers`, () => HttpResponse.json({ data: list }));

export const crLegacyAdSets = (advertiserId: string, list: Row[]) => http.get(`${CR}/advertisers/${advertiserId}/ad-sets`, () => HttpResponse.json({ data: list }));

export const crLegacyPatch = () => http.patch(`${CR}/ad-sets/:id`, async ({ request }) => HttpResponse.json(await request.json()));

export function crLegacyCreate(campaignId: string | null = "cmp-9") {
  let n = 0;
  return [
    http.post(`${CR}/advertisers/:adv/ad-sets`, async ({ request }) => {
      const body = (await request.json()) as Row;
      return HttpResponse.json({ data: { ...body.data, id: `set${++n}`, attributes: { ...body.data.attributes, ...(campaignId ? { campaignId } : {}) } } });
    }),
    http.post(`${CR}/ad-sets/:id/ads`, async ({ request }) => HttpResponse.json({ data: { ...((await request.json()) as Row).data, id: `ad${++n}` } })),
  ];
}
