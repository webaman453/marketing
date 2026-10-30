/**
 * Google OAuth + Google Ads API (REST) fakes.
 *
 * Shapes:
 *  - OAuth authorize / token / revoke:
 *    https://developers.google.com/identity/protocols/oauth2/web-server
 *    (token response: access_token, expires_in, refresh_token (first exchange only), scope, token_type;
 *     a refresh_token grant normally returns no new refresh_token; bad/revoked refresh tokens give
 *     HTTP 400 { "error": "invalid_grant", "error_description": "..." })
 *  - OpenID userinfo: https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation
 *  - customers:listAccessibleCustomers (GET → { resourceNames: ["customers/123"] }):
 *    https://developers.google.com/google-ads/api/rest/reference/rest/v21/customers/listAccessibleCustomers
 *  - googleAds:search (POST { query, pageToken } → { results, nextPageToken, fieldMask }):
 *    https://developers.google.com/google-ads/api/rest/reference/rest/v21/customers.googleAds/search
 *    Rows use camelCase field names, int64 values (ids, micros, impressions, clicks) are JSON strings,
 *    doubles (conversions, conversions_value) are JSON numbers:
 *    https://developers.google.com/google-ads/api/rest/design/json-mappings
 *  - campaigns:mutate / campaignBudgets:mutate (→ { results: [{ resourceName }] }):
 *    https://developers.google.com/google-ads/api/rest/reference/rest/v21/customers.campaigns/mutate
 *  - googleAds:mutate (POST { mutateOperations } → { mutateOperationResponses: [{ campaignResult: { resourceName } }, …] }):
 *    https://developers.google.com/google-ads/api/rest/reference/rest/v21/customers.googleAds/mutate
 *    Atomic unless partialFailure is set: one failing operation and nothing is created.
 *  - geoTargetConstants:suggest:
 *    https://developers.google.com/google-ads/api/rest/reference/rest/v21/geoTargetConstants/suggest
 *  - Error envelope (google.rpc.Status with a GoogleAdsFailure detail):
 *    https://developers.google.com/google-ads/api/docs/best-practices/error-types
 *    https://developers.google.com/google-ads/api/rest/common/errors  // unverified exact URL
 */
import { http, HttpResponse } from "msw";

export const GOOGLE_VERSION = "v21";
export const ADS = `https://googleads.googleapis.com/${GOOGLE_VERSION}`;
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export const googleConfig = { clientId: "g-client", clientSecret: "g-secret", apiVersion: GOOGLE_VERSION };

type Row = Record<string, unknown>;

/** google.rpc.Status error body as the Google Ads API returns it. */
export function googleAdsError(code: number, grpcStatus: string, message: string, detailMessage?: string, errorCode: Record<string, string> = {}) {
  return HttpResponse.json(
    {
      error: {
        code,
        message,
        status: grpcStatus,
        details: detailMessage
          ? [
              {
                "@type": `type.googleapis.com/google.ads.googleads.${GOOGLE_VERSION}.errors.GoogleAdsFailure`,
                errors: [{ errorCode, message: detailMessage }],
                requestId: "req-123",
              },
            ]
          : [],
      },
    },
    { status: code },
  );
}

export const tokenOk = (body: Row = {}) =>
  http.post(GOOGLE_TOKEN, () =>
    HttpResponse.json({ access_token: "ya29.access", expires_in: 3599, refresh_token: "1//refresh", scope: "https://www.googleapis.com/auth/adwords openid email profile", token_type: "Bearer", ...body }),
  );

/** The GAQL resource after FROM (campaign, ad_group, ad_group_ad, customer_client…). */
export const fromOf = (query: string) => /\bFROM\s+(\w+)/i.exec(query)?.[1] ?? "";

export type SearchReply = { results?: Row[]; nextPageToken?: string } | Response;
export type SearchFn = (args: { cid: string; query: string; pageToken?: string; request: Request }) => SearchReply | Promise<SearchReply>;

/**
 * googleAds:search fake. `routes` maps a GAQL FROM resource to its rows (one page)
 * or to a function for paging / errors. Unknown resources answer with no rows.
 */
export function googleSearch(routes: Record<string, Row[] | SearchFn>) {
  return http.post(`${ADS}/customers/:cid/googleAds\\:search`, async ({ request, params }) => {
    const body = (await request.clone().json()) as { query: string; pageToken?: string };
    const route = routes[fromOf(body.query)];
    const reply = typeof route === "function" ? await route({ cid: String(params.cid), query: body.query, pageToken: body.pageToken, request }) : { results: route ?? [] };
    if (reply instanceof Response) return reply;
    return HttpResponse.json({ ...reply, fieldMask: "unverified.field.mask" });
  });
}

/** Splits rows into pages of `size`, keyed by nextPageToken "p2", "p3", … */
export function paged(rows: Row[], size: number): SearchFn {
  return ({ pageToken }) => {
    const page = pageToken ? Number(pageToken.slice(1)) : 1;
    const results = rows.slice((page - 1) * size, page * size);
    return { results, ...(page * size < rows.length ? { nextPageToken: `p${page + 1}` } : {}) };
  };
}

export const listAccessible = (ids: string[]) =>
  http.get(`${ADS}/customers\\:listAccessibleCustomers`, () => HttpResponse.json({ resourceNames: ids.map((id) => `customers/${id}`) }));

export const customerClient = (id: string, over: Row = {}) => ({
  customerClient: {
    resourceName: `customers/root/customerClients/${id}`,
    id,
    descriptiveName: `Account ${id}`,
    currencyCode: "INR",
    timeZone: "Asia/Kolkata",
    manager: false,
    status: "ENABLED",
    level: "1",
    ...over,
  },
});

/** Answers each mutate operation with a resource name, the way GoogleAdsService.Mutate does. */
export function mutateResponses(cid: string, ops: Record<string, any>[]) {
  let n = 1000;
  return ops.map((op) => {
    const [opKey, body] = Object.entries(op)[0]!;
    const kind = opKey.replace(/Operation$/, "");
    const resultKey = `${kind}Result`;
    const temp = body?.create?.resourceName as string | undefined;
    const collection = temp ? temp.split("/")[2] : `${kind}s`;
    return { [resultKey]: { resourceName: `customers/${cid}/${collection}/${n++}` } };
  });
}

export function googleMutate(reply?: (ops: Record<string, any>[], cid: string) => Response | object) {
  return http.post(`${ADS}/customers/:cid/googleAds\\:mutate`, async ({ request, params }) => {
    const { mutateOperations } = (await request.clone().json()) as { mutateOperations: Record<string, any>[] };
    const cid = String(params.cid);
    const out = reply?.(mutateOperations, cid);
    if (out instanceof Response) return out;
    return HttpResponse.json(out ?? { mutateOperationResponses: mutateResponses(cid, mutateOperations) });
  });
}

export const languageRows = (codes: Record<string, string>) =>
  Object.entries(codes).map(([code, id]) => ({ languageConstant: { resourceName: `languageConstants/${id}`, code } }));
