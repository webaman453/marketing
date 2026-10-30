/**
 * X Ads API + OAuth 1.0a handlers. Every handler checks the request's OAuth 1.0a
 * HMAC-SHA1 signature with an implementation written here, independently of the
 * product's oauth1.ts, and answers 401 like X does when it does not verify.
 *
 * Docs:
 *  - Signing: https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
 *    (RFC 5849 §3.4: https://www.rfc-editor.org/rfc/rfc5849#section-3.4)
 *  - Request/access token: https://docs.x.com/fundamentals/authentication/api-reference/request_token
 *    and .../access_token (form-encoded replies)
 *  - Accounts, campaigns, line items, promoted tweets (cursor/next_cursor paging, *_local_micro money):
 *    https://developer.x.com/en/docs/x-ads-api/campaign-management/api-reference
 *  - Promotable users: https://developer.x.com/en/docs/x-ads-api/campaign-management/api-reference/promotable-users
 *  - Ads API tweet (nullcast): https://developer.x.com/en/docs/x-ads-api/creatives/api-reference/tweets
 *  - Sync stats (id_data[].metrics arrays, one value per day):
 *    https://developer.x.com/en/docs/x-ads-api/analytics/api-reference/synchronous
 *  - v2 media upload: https://docs.x.com/x-api/media/media-upload-initialize  // unverified: exact reply shape
 *  - Media library: https://developer.x.com/en/docs/x-ads-api/creatives/api-reference/media-library
 */
import { createHmac } from "node:crypto";
import { http, HttpResponse } from "../server";

export const X_ADS = "https://ads-api.x.com/12";
export const X_OAUTH = "https://api.x.com/oauth";
export const X_CONSUMER = { consumerKey: "ck-test", consumerSecret: "cs-test" };
/** The user token a connected test login holds. */
export const X_USER = { token: "user-token", secret: "user-secret", userId: "777", screenName: "ashniva" };
export const X_REQUEST = { token: "req-token", secret: "req-secret" };

type Row = Record<string, unknown>;

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Parses `Authorization: OAuth k="v", …`. */
export function parseOAuthHeader(header: string | null): Record<string, string> | null {
  if (!header?.startsWith("OAuth ")) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(6).matchAll(/([\w%-]+)="([^"]*)"/g)) out[decodeURIComponent(m[1]!)] = decodeURIComponent(m[2]!);
  return out;
}

/** RFC 5849 §3.4.1 base string + §3.4.2 HMAC-SHA1, computed independently from the product. */
export function expectedSignature(method: string, url: string, oauth: Record<string, string>, consumerSecret: string, tokenSecret: string, form: Record<string, string> = {}) {
  const u = new URL(url);
  const pairs: [string, string][] = [];
  u.searchParams.forEach((v, k) => pairs.push([enc(k), enc(v)]));
  for (const [k, v] of Object.entries(form)) pairs.push([enc(k), enc(v)]);
  for (const [k, v] of Object.entries(oauth)) if (k !== "oauth_signature" && k !== "realm") pairs.push([enc(k), enc(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), enc(`${u.protocol}//${u.host.toLowerCase()}${u.pathname}`), enc(pairs.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  return createHmac("sha1", `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest("base64");
}

const secrets: Record<string, string> = { [X_USER.token]: X_USER.secret, [X_REQUEST.token]: X_REQUEST.secret };

/** Null when the request is correctly signed, else the 401 X would answer. */
function verify(request: Request): Response | null {
  const oauth = parseOAuthHeader(request.headers.get("authorization"));
  const unauthorized = (message: string) => HttpResponse.json({ errors: [{ code: "UNAUTHORIZED_ACCESS", message }], request: { params: {} } }, { status: 401 });
  if (!oauth) return unauthorized("This request is not properly authenticated");
  if (oauth.oauth_consumer_key !== X_CONSUMER.consumerKey || oauth.oauth_signature_method !== "HMAC-SHA1" || oauth.oauth_version !== "1.0") return unauthorized("Bad OAuth parameters");
  const tokenSecret = oauth.oauth_token ? secrets[oauth.oauth_token] : "";
  if (tokenSecret === undefined) return unauthorized("Invalid or expired token");
  if (oauth.oauth_signature !== expectedSignature(request.method, request.url, oauth, X_CONSUMER.consumerSecret, tokenSecret)) return unauthorized("Could not authenticate you");
  return null;
}

type Resolver = (info: { request: Request; url: URL; params: Record<string, string> }) => Response | Promise<Response>;
const signed = (resolve: Resolver) => async ({ request, params }: { request: Request; params: Record<string, unknown> }) =>
  verify(request) ?? resolve({ request, url: new URL(request.url), params: params as Record<string, string> });

export const xGet = (path: string, resolve: Resolver) => http.get(`${X_ADS}${path}`, signed(resolve));
export const xPost = (path: string, resolve: Resolver) => http.post(`${X_ADS}${path}`, signed(resolve));
export const xPut = (path: string, resolve: Resolver) => http.put(`${X_ADS}${path}`, signed(resolve));
export const xDelete = (path: string, resolve: Resolver) => http.delete(`${X_ADS}${path}`, signed(resolve));

/** POST oauth/request_token → `oauth_token=…&oauth_token_secret=…&oauth_callback_confirmed=true`. */
export const xRequestToken = (body = `oauth_token=${X_REQUEST.token}&oauth_token_secret=${X_REQUEST.secret}&oauth_callback_confirmed=true`) =>
  http.post(`${X_OAUTH}/request_token`, signed(() => new HttpResponse(body, { headers: { "Content-Type": "text/html; charset=utf-8" } })));

/** POST oauth/access_token → `oauth_token=…&oauth_token_secret=…&user_id=…&screen_name=…`. */
export const xAccessToken = (body = `oauth_token=${X_USER.token}&oauth_token_secret=${X_USER.secret}&user_id=${X_USER.userId}&screen_name=${X_USER.screenName}`) =>
  http.post(`${X_OAUTH}/access_token`, signed(() => new HttpResponse(body, { headers: { "Content-Type": "text/html; charset=utf-8" } })));

/** A cursor-paged list: `{ data, next_cursor, request }`, next_cursor null on the last page. */
export function xList(path: string, pages: (Row[] | number)[], opts: { endless?: boolean } = {}) {
  return xGet(path, ({ url }) => {
    const cursor = url.searchParams.get("cursor");
    const index = cursor ? Number(cursor.replace("c", "")) : 0;
    const page = pages[Math.min(index, pages.length - 1)] ?? [];
    if (typeof page === "number") return HttpResponse.json({ errors: [{ code: "ERR", message: `list failed ${page}` }] }, { status: page });
    const last = !opts.endless && index >= pages.length - 1;
    return HttpResponse.json({ request: { params: {} }, data: page, data_type: "x", total_count: page.length, next_cursor: last ? null : `c${index + 1}` });
  });
}

/** One sync-stats entity row with daily metric arrays (null when X has no data). */
export const statsRow = (id: string, metrics: Record<string, (number | string)[] | null>) => ({ id, id_data: [{ segment: null, metrics }] });
