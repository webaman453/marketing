/**
 * Taboola Backstage API 1.0 handlers.
 * Docs: https://developers.taboola.com/backstage-api/reference
 *  - Token: POST /backstage/oauth/token, form client_id, client_secret, grant_type=client_credentials →
 *    { access_token, token_type: "bearer", expires_in } (https://developers.taboola.com/backstage-api/reference/client-credentials-flow)
 *  - GET /users/current/account and GET /users/current/allowed-accounts → { results: [{ id, name, account_id, currency, time_zone_name, ... }] }
 *    (https://developers.taboola.com/backstage-api/reference/get-allowed-accounts)
 *  - GET /{account_id}/campaigns/ → { results: [campaign], metadata } with daily_cap / spending_limit in account currency units
 *    (https://developers.taboola.com/backstage-api/reference/get-all-campaigns)
 *  - Updates are POST /{account_id}/campaigns/{campaign_id}/ with the changed fields only.
 *  - GET /{account_id}/campaigns/{campaign_id}/items/ → { results: [item] }.
 *  - GET /{account_id}/reports/campaign-summary/dimensions/campaign_day_breakdown?start_date&end_date →
 *    { results: [{ date: "YYYY-MM-DD 00:00:00.0", campaign, impressions, clicks, spent, cpa_actions_num, conversions_value, ... }] }
 *    (https://developers.taboola.com/backstage-api/reference/campaign-summary-report)  // row field names from memory: unverified
 *  - POST /{account_id}/images/ multipart upload → { value: <hosted url> }.   // unverified
 */
import { http, HttpResponse } from "msw";

export const TB_HOST = "https://backstage.taboola.com";
export const TB = `${TB_HOST}/backstage/api/1.0`;
export const TB_TOKEN = `${TB_HOST}/backstage/oauth/token`;
type Row = Record<string, any>;

export const tbToken = (body: Row = { access_token: "tb-access", token_type: "bearer", expires_in: 43200 }) => http.post(TB_TOKEN, () => HttpResponse.json(body));

export const tbAccount = (id: string, over: Row = {}) => ({ id: 1000 + id.length, name: `Account ${id}`, account_id: id, partner_types: ["ADVERTISER"], type: "PARTNER", currency: "USD", time_zone_name: "US/Eastern", ...over });

export const tbCampaign = (id: string, over: Row = {}) => ({
  id,
  name: `Campaign ${id}`,
  branding_text: "Ashniva",
  is_active: true,
  status: "RUNNING",
  marketing_objective: "DRIVE_WEBSITE_TRAFFIC",
  daily_cap: 50,
  spending_limit: 1500,
  spending_limit_model: "ENTIRE",
  bid_strategy: "SMART",
  start_date: "2026-10-01",
  end_date: "2026-11-30",
  ...over,
});

export const tbItem = (id: string, over: Row = {}) => ({ id, title: `Item ${id}`, description: "desc", url: "https://shop.example.com/i", thumbnail_url: `https://images.taboola.test/${id}.jpg`, is_active: true, status: "RUNNING", ...over });

export function tbCreate() {
  let n = 0;
  return [
    http.post(`${TB}/:acct/campaigns/`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), id: `tbc${++n}` })),
    http.post(`${TB}/:acct/campaigns/:cid/items/`, async ({ request }) => HttpResponse.json({ ...((await request.json()) as Row), id: `tbi${++n}`, status: "CRAWLING" })),
    http.post(`${TB}/:acct/campaigns/:cid/`, async ({ request, params }) => HttpResponse.json({ id: params.cid, ...((await request.json()) as Row) })),
    http.post(`${TB}/:acct/images/`, async ({ request }) => {
      const file = (await request.formData()).get("file");
      return HttpResponse.json({ value: "https://cdn.taboola.test/uploaded.jpg", size: file instanceof Blob ? file.size : 0 });
    }),
  ];
}
