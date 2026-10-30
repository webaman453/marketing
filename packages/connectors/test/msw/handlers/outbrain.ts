/**
 * Outbrain Amplify API v0.1 handlers.
 * Docs: https://developer.outbrain.com/home-page/amplify-api/ (reference: https://amplifyv01.docs.apiary.io/)
 *  - Auth header `OB-TOKEN-V1: <token>`.
 *  - GET /marketers → { marketers: [{ id, name, enabled, currency, ... }], count }.                       // unverified
 *  - GET /marketers/{id}/campaigns → { campaigns: [...], count, totalCount }, limit/offset paging.          // unverified
 *  - GET /campaigns/{id}/promotedLinks?limit&offset → { promotedLinks: [...], totalCount }.                // unverified
 *  - GET /reports/marketers/{id}/campaigns/periodic?from&to&breakdown=daily →
 *    { campaignResults: [{ campaignId, results: [{ metadata: { id: "YYYY-MM-DD", fromDate, toDate }, metrics: {...} }] }] }. // unverified
 */
import { http, HttpResponse } from "msw";

export const OB = "https://api.outbrain.com/amplify/v0.1";
type Row = Record<string, any>;

export const marketer = (id: string, over: Row = {}) => ({ id, name: `Marketer ${id}`, enabled: true, currency: "USD", ...over });

export const obCampaign = (id: string, over: Row = {}) => ({ id, name: `Campaign ${id}`, enabled: true, objective: "Traffic", cpc: 0.35, budget: { id: `b-${id}`, amount: 120, type: "DAILY" }, ...over });

export const promotedLink = (id: string, over: Row = {}) => ({ id, text: `Link ${id}`, url: "https://shop.example.com/p", enabled: true, imageMetadata: { url: `https://images.outbrain.test/${id}.jpg` }, ...over });

export const obMarketers = (list: Row[]) => http.get(`${OB}/marketers`, () => HttpResponse.json({ marketers: list, count: list.length }));

export const obCampaigns = (marketerId: string, list: Row[]) => http.get(`${OB}/marketers/${marketerId}/campaigns`, () => HttpResponse.json({ campaigns: list, count: list.length, totalCount: list.length }));

/** Promoted links paged with limit/offset like the Amplify docs describe. */
export const obLinks = (byCampaign: Record<string, Row[]>) =>
  http.get(`${OB}/campaigns/:id/promotedLinks`, ({ params, request }) => {
    const all = byCampaign[String(params.id)] ?? [];
    const q = new URL(request.url).searchParams;
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 50);
    return HttpResponse.json({ promotedLinks: all.slice(offset, offset + limit), totalCount: all.length });
  });

export function obCreate() {
  let n = 0;
  return [
    http.post(`${OB}/marketers/:id/campaigns`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), id: `obc${++n}` })),
    http.post(`${OB}/campaigns/:id/promotedLinks`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), id: `obl${++n}` })),
    http.put(`${OB}/campaigns/:id`, async ({ request }) => HttpResponse.json(await request.json())),
  ];
}
