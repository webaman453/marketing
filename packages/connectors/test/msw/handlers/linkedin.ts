/**
 * LinkedIn Marketing API (versioned REST) handlers, shaped after the official docs:
 *  - OAuth 3-legged flow: https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow
 *  - Refresh tokens:      https://learn.microsoft.com/linkedin/shared/authentication/programmatic-refresh-tokens
 *  - Ad accounts (cursor paging, metadata.nextPageToken, pageSize ≤ 1000, since 202401):
 *    https://learn.microsoft.com/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts
 *  - Creatives (q=criteria, cursor paging, pageSize ≤ 100, x-restli-id on create):
 *    https://learn.microsoft.com/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives
 *  - Campaign conversions (PUT .../campaignConversions/(campaign:…,conversion:…)):
 *    https://learn.microsoft.com/linkedin/marketing/integrations/ads-reporting/conversion-tracking
 *  - adAnalytics: https://learn.microsoft.com/linkedin/marketing/integrations/ads-reporting/ads-reporting
 */
import { http, HttpResponse } from "../server";

export const LI_REST = "https://api.linkedin.com/rest";
export const LI_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LI_USERINFO = "https://api.linkedin.com/v2/userinfo";

type Row = Record<string, unknown>;

/** Access-token response (authorization-code-flow doc, "Sample Response"). */
export const liToken = (over: Row = {}) =>
  http.post(LI_TOKEN_URL, () =>
    HttpResponse.json({
      access_token: "li-access",
      expires_in: 5184000,
      refresh_token: "li-refresh",
      refresh_token_expires_in: 31536000,
      scope: "r_ads,rw_ads,r_ads_reporting",
      ...over,
    }),
  );

/** OpenID userinfo (https://learn.microsoft.com/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2). */
export const liUserinfo = (body: Row = { sub: "782bbtaQ", name: "Asha Rao", email: "asha@example.com" }) => http.get(LI_USERINFO, () => HttpResponse.json(body));

/**
 * A search finder for `path` (e.g. "/adAccounts") serving `rows` with the documented
 * cursor paging: pageSize + pageToken in, metadata.nextPageToken out. Legacy
 * start/count is honoured too (Rest.li offset paging, pre-202401).
 */
export function liFinder(path: string, rows: Row[], opts: { maxPageSize?: number; cursorOnly?: boolean } = {}) {
  return http.get(`${LI_REST}${path}`, ({ request }) => {
    const u = new URL(request.url);
    const max = opts.maxPageSize ?? 1000;
    // cursorOnly: the documented 202401+ behaviour, where start/count are not paging parameters.
    const legacyCount = opts.cursorOnly ? null : u.searchParams.get("count");
    const legacyStart = opts.cursorOnly ? null : u.searchParams.get("start");
    // Default page size 100 is documented for creatives; assumed for the other finders. // unverified
    const size = Math.min(Number(u.searchParams.get("pageSize") ?? legacyCount ?? 100) || 100, max);
    const start = u.searchParams.has("pageToken") ? Number(u.searchParams.get("pageToken")!.replace("tok-", "")) : Number(legacyStart ?? 0);
    const elements = rows.slice(start, start + size);
    const next = start + size < rows.length ? `tok-${start + size}` : undefined;
    return HttpResponse.json({ elements, metadata: next ? { nextPageToken: next } : {}, paging: { start, count: size } });
  });
}

/** adAnalytics finder: rows per pivot (CAMPAIGN / CREATIVE). */
export function liAnalytics(byPivot: Record<string, Row[]>) {
  return http.get(`${LI_REST}/adAnalytics`, ({ request }) => {
    const pivot = new URL(request.url).searchParams.get("pivot") ?? "";
    return HttpResponse.json({ elements: byPivot[pivot] ?? [], paging: { count: 10, start: 0, links: [] } });
  });
}

/** One adAnalytics element (fields documented on the ads-reporting page; cost is a string BigDecimal). */
export const liStat = (urn: string, day: string, m: Partial<Record<"impressions" | "clicks" | "cost" | "conv" | "value" | "video", number | string>>) => {
  const [y, mo, d] = day.split("-").map(Number);
  return {
    pivotValues: [urn],
    dateRange: { start: { year: y, month: mo, day: d }, end: { year: y, month: mo, day: d } },
    impressions: m.impressions ?? 0,
    clicks: m.clicks ?? 0,
    costInLocalCurrency: String(m.cost ?? "0"),
    externalWebsiteConversions: m.conv ?? 0,
    conversionValueInLocalCurrency: String(m.value ?? "0"),
    videoViews: m.video ?? 0,
  };
};

/** Create endpoints: 201 with the new id in x-restli-id (documented for groups, campaigns and creatives). */
export const liCreate = (path: string, id: string) =>
  http.post(`${LI_REST}${path}`, () => new HttpResponse(null, { status: 201, headers: { "x-restli-id": id } }));

/** Image upload: initializeUpload → value.uploadUrl + value.image (https://learn.microsoft.com/linkedin/marketing/community-management/shares/images-api). */
export const liImageUpload = (image = "urn:li:image:C4E10AQ") => [
  http.post(`${LI_REST}/images`, () => HttpResponse.json({ value: { uploadUrlExpiresAt: 1790000000000, uploadUrl: "https://www.linkedin.com/dms-uploads/upload-1", image } })),
  http.put("https://www.linkedin.com/dms-uploads/upload-1", () => new HttpResponse(null, { status: 201 })),
];

/** Location typeahead (https://learn.microsoft.com/linkedin/marketing/integrations/ads/advertising-targeting/ads-targeting#typeahead). */
export const liTypeahead = (elements: Row[] = [{ urn: "urn:li:geo:102713980", name: "India", facetUrn: "urn:li:adTargetingFacet:locations" }]) =>
  http.get(`${LI_REST}/adTargetingEntities`, () => HttpResponse.json({ elements }));

/** Partial update ($set) on a campaign group: 204 No Content. */
export const liPartialUpdate = (pathRe: RegExp) => http.post(pathRe, () => new HttpResponse(null, { status: 204 }));
