/**
 * Amazon Ads API + Login with Amazon handlers, shaped after the official docs:
 *  - LWA token: https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html
 *    and https://advertising.amazon.com/API/docs/en-us/guides/get-started/retrieve-access-token
 *  - Profiles: https://advertising.amazon.com/API/docs/en-us/reference/2/profiles
 *  - SP v3 (list with nextToken, 207 multi-status writes):
 *    https://advertising.amazon.com/API/docs/en-us/sponsored-products/3-0/openapi/prod
 *  - SB v4: https://advertising.amazon.com/API/docs/en-us/sponsored-brands/4-0/openapi/prod
 *  - SD v3 (startIndex/count paging, array replies with `code`):
 *    https://advertising.amazon.com/API/docs/en-us/sponsored-display/3-0/openapi
 */
import { http, HttpResponse } from "../server";

export const AMZ_NA = "https://advertising-api.amazon.com";
export const AMZ_EU = "https://advertising-api-eu.amazon.com";
export const AMZ_FE = "https://advertising-api-fe.amazon.com";
export const AMZ_REGIONS = [AMZ_NA, AMZ_EU, AMZ_FE];
export const LWA_TOKEN = "https://api.amazon.com/auth/o2/token";

type Row = Record<string, unknown>;

/** LWA token reply: { access_token, refresh_token, token_type: "bearer", expires_in: 3600 }. */
export const lwaToken = (over: Row = {}) =>
  http.post(LWA_TOKEN, () => HttpResponse.json({ access_token: "Atza|access", refresh_token: "Atzr|refresh", token_type: "bearer", expires_in: 3600, ...over }));

/** One /v2/profiles row (documented fields). */
export const profile = (profileId: number, over: Row = {}): Row => ({
  profileId,
  countryCode: "US",
  currencyCode: "USD",
  dailyBudget: 999999999,
  timezone: "America/Los_Angeles",
  accountInfo: { marketplaceStringId: "ATVPDKIKX0DER", id: `A${profileId}`, type: "seller", name: "Ashniva Store", validPaymentMethod: true },
  ...over,
});

/** GET /v2/profiles per region host: rows, or an HTTP status to fail with. */
export function amazonProfiles(byHost: Partial<Record<string, Row[] | number>>) {
  return AMZ_REGIONS.map((host) =>
    http.get(`${host}/v2/profiles`, () => {
      const v = byHost[host] ?? [];
      if (typeof v === "number") return HttpResponse.json({ code: String(v), details: "region error" }, { status: v });
      return HttpResponse.json(v);
    }),
  );
}

/**
 * A v3/v4 POST .../list endpoint paged with nextToken. `pages[i]` is the rows of page i;
 * the reply carries `nextToken` until the last page. A number page fails with that status.
 */
export function tokenList(host: string, path: string, key: string, pages: (Row[] | number)[], opts: { endless?: boolean } = {}) {
  return http.post(`${host}${path}`, async ({ request }) => {
    const body = (await request.json()) as { nextToken?: string };
    const index = body?.nextToken ? Number(body.nextToken.replace("tok-", "")) : 0;
    const page = pages[Math.min(index, pages.length - 1)] ?? [];
    if (typeof page === "number") return HttpResponse.json({ code: String(page), details: "list failed" }, { status: page });
    const last = !opts.endless && index >= pages.length - 1;
    return HttpResponse.json({ [key]: page, totalResults: 0, ...(last ? {} : { nextToken: `tok-${index + 1}` }) });
  });
}

/** SD v3 GET /sd/campaigns paged with startIndex/count. */
export function sdList(host: string, rows: Row[] | number) {
  return http.get(`${host}/sd/campaigns`, ({ request }) => {
    if (typeof rows === "number") return HttpResponse.json({ code: String(rows), details: "sd failed" }, { status: rows });
    const u = new URL(request.url);
    const start = Number(u.searchParams.get("startIndex") ?? 0);
    const count = Number(u.searchParams.get("count") ?? 100);
    return HttpResponse.json(rows.slice(start, start + count));
  });
}

/** SP v3 / SB v4 207 multi-status reply for one created entity. */
export const created207 = (key: string, idKey: string, id: string) =>
  HttpResponse.json({ [key]: { success: [{ index: 0, [idKey]: id }], error: [] } }, { status: 207 });

/** SP v3 / SB v4 207 multi-status reply with one failed item. */
export const failed207 = (key: string, message: string) =>
  HttpResponse.json({ [key]: { success: [], error: [{ index: 0, errors: [{ errorType: "invalidArgument", errorValue: { invalidArgument: { reason: "INVALID_ARGUMENT", message } } }] }] } }, { status: 207 });

/** SD v3 207 reply: an array of `{ code, <idKey> }`. */
export const sd207 = (idKey: string, id: number, code = "SUCCESS") => HttpResponse.json([{ code, [idKey]: id, ...(code === "SUCCESS" ? {} : { description: "rejected by SD" }) }], { status: 207 });
