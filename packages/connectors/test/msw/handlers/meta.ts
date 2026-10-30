/**
 * MSW handlers for the Meta Graph / Marketing API, shaped after Meta's docs.
 *
 * - Errors: https://developers.facebook.com/docs/graph-api/guides/error-handling/
 *   `{ error: { message, type, code, error_subcode, fbtrace_id } }`; code 190 = invalid/expired
 *   token, 4/17/32/613 = rate limiting, 10 and 200-299 = permission errors.
 * - Paging: https://developers.facebook.com/docs/graph-api/results
 *   `{ data: [...], paging: { cursors: { before, after }, next? } }`; `next` is a full URL and
 *   is absent on the last page.
 * - Tokens: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow#confirm
 *   and https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
 *   `{ access_token, token_type: "bearer", expires_in }` (GET /oauth/access_token).
 */
import { http, HttpResponse } from "msw";

export const META_VERSION = "v26.0";
export const GRAPH = `https://graph.facebook.com/${META_VERSION}`;

export const metaConfig = { appId: "app-123", appSecret: "app-secret", apiVersion: META_VERSION };

/** Graph error body (error-handling guide above). */
export function metaErrorBody(code: number, message = `Graph error ${code}`, subcode?: number) {
  return {
    error: {
      message,
      type: code === 190 ? "OAuthException" : "GraphMethodException",
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
      fbtrace_id: "AbCdEfGh123",
    },
  };
}

export const metaError = (status: number, code: number, message?: string, subcode?: number) =>
  HttpResponse.json(metaErrorBody(code, message, subcode), { status });

/**
 * A Graph edge served page by page. Page i links to page i+1 with `paging.next`
 * (a full URL carrying an `after` cursor, like Meta does); the last page has no `next`.
 * `onPage` can replace any page's response (e.g. an error on page 2).
 */
export function metaEdge(method: "get" | "post", path: string, pages: unknown[][], onPage?: (index: number) => Response | undefined) {
  return http[method](`${GRAPH}${path}`, ({ request }) => {
    const url = new URL(request.url);
    const index = Number(url.searchParams.get("after")?.replace("cursor-", "") ?? 0);
    const custom = onPage?.(index);
    if (custom) return custom;
    const data = pages[index] ?? [];
    const next = new URL(url);
    next.searchParams.set("after", `cursor-${index + 1}`);
    return HttpResponse.json({
      data,
      paging: {
        cursors: { before: `cursor-${index}`, after: `cursor-${index + 1}` },
        ...(index + 1 < pages.length ? { next: next.toString() } : {}),
      },
    });
  });
}

/** Short-lived then long-lived token exchange, both GET /oauth/access_token. */
export function metaTokenHandlers(opts: { longExpiresIn?: number | null } = {}) {
  return [
    http.get(`${GRAPH}/oauth/access_token`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      if (q.get("grant_type") === "fb_exchange_token") {
        return HttpResponse.json({
          access_token: `long-${q.get("fb_exchange_token")}`,
          token_type: "bearer",
          ...(opts.longExpiresIn === null ? {} : { expires_in: opts.longExpiresIn ?? 5_183_944 }),
        });
      }
      if (q.get("code") === "bad-code") return metaError(400, 100, "Invalid verification code format.", 36007); // unverified subcode
      return HttpResponse.json({ access_token: "short-1", token_type: "bearer", expires_in: 5183 });
    }),
  ];
}

/** An ad account row (https://developers.facebook.com/docs/marketing-api/reference/ad-account/). */
export const metaAccount = (id: string, over: Record<string, unknown> = {}) => ({
  id: `act_${id}`,
  account_id: id,
  name: `Account ${id}`,
  currency: "USD",
  timezone_name: "America/Los_Angeles",
  account_status: 1,
  ...over,
});

/**
 * Insights row (https://developers.facebook.com/docs/marketing-api/insights/ and
 * https://developers.facebook.com/docs/marketing-api/reference/ads-insights/):
 * numbers come back as strings; actions/action_values are `{ action_type, value }` lists.
 */
export const insightRow = (idField: string, id: string, date: string, over: Record<string, unknown> = {}) => ({
  [idField]: id,
  date_start: date,
  date_stop: date,
  impressions: "1000",
  clicks: "25",
  spend: "12.34",
  ...over,
});

/**
 * Everything createCampaign calls, each returning `{ id }` as the Marketing API does for
 * POST /act_{id}/campaigns|adsets|adcreatives|ads
 * (https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/#Creating).
 * /adimages returns `{ images: { <name>: { hash, url } } }`
 * (https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages/#Creating).
 * DELETE /{id} returns `{ success: true }`.
 */
export function metaCreateHandlers(opts: { fail?: Partial<Record<"campaigns" | "adsets" | "adcreatives" | "ads" | "adimages" | "delete", Response>> } = {}) {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const post = (edge: "campaigns" | "adsets" | "adcreatives" | "ads", prefix: string) =>
    http.post(`${GRAPH}/:act/${edge}`, () => opts.fail?.[edge]?.clone() ?? HttpResponse.json({ id: id(prefix) }));
  return [
    post("campaigns", "cmp"),
    post("adsets", "set"),
    post("adcreatives", "cre"),
    post("ads", "ad"),
    http.post(`${GRAPH}/:act/adimages`, () => opts.fail?.adimages?.clone() ?? HttpResponse.json({ images: { "upload.jpg": { hash: "hash-abc", url: "https://scontent.example/hash-abc.jpg" } } })),
    // https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/#Creating
    http.post(`${GRAPH}/:act/advideos`, () => HttpResponse.json({ id: "vid-99" })),
    // https://developers.facebook.com/docs/graph-api/reference/video/ (status.video_status, picture)
    http.get(`${GRAPH}/vid-99`, () => HttpResponse.json({ id: "vid-99", status: { video_status: "ready" }, picture: "https://scontent.example/vid-99.jpg" })),
    // Locale search: https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-search/#locale
    http.get(`${GRAPH}/search`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      if (q.get("type") === "adlocale") return HttpResponse.json({ data: [{ key: 6, name: "English (US)" }, { key: 1001, name: "English (All)" }] });
      return HttpResponse.json({ data: [] });
    }),
    http.delete(`${GRAPH}/:id`, () => opts.fail?.delete?.clone() ?? HttpResponse.json({ success: true })),
  ];
}
