/**
 * Microsoft Advertising (Bing Ads API v13, REST/JSON) handlers, shaped after the official docs:
 *  - OAuth (Microsoft identity platform): https://learn.microsoft.com/advertising/guides/authentication-oauth-get-tokens
 *    and https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow (token response fields)
 *  - Campaigns/QueryByAccountId (REST URL, body, Campaigns[] response):
 *    https://learn.microsoft.com/advertising/campaign-management-service/getcampaignsbyaccountid
 *  - Customer Management (User/Query, AccountsInfo/Query, Account/Query):
 *    https://learn.microsoft.com/advertising/customer-management-service/getuser
 *    https://learn.microsoft.com/advertising/customer-management-service/getaccountsinfo
 *    https://learn.microsoft.com/advertising/customer-management-service/getaccount
 *  - Reporting Submit/Poll (Status: Error | Pending | Success; ReportDownloadUrl nil when no data):
 *    https://learn.microsoft.com/advertising/reporting-service/submitgeneratereport
 *    https://learn.microsoft.com/advertising/reporting-service/pollgeneratereport
 *  - Faults (AdApiFaultDetail.Errors[], ApiFaultDetail.OperationErrors[]; code 105 bad token, 117 rate limit):
 *    https://learn.microsoft.com/advertising/guides/handle-service-errors-exceptions
 *  - PartialErrors (BatchError[]): same page, "Partial Success With the Campaign Management Service".
 */
import { strToU8, zipSync } from "fflate";
import { http, HttpResponse } from "../server";

export const MS_CAMPAIGN = "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13";
export const MS_CUSTOMER = "https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13";
export const MS_REPORTING = "https://reporting.api.bingads.microsoft.com/Reporting/v13";
export const msTokenUrl = (tenant = "common") => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

type Row = Record<string, unknown>;

export const msToken = (over: Row = {}, tenant = "common") =>
  http.post(msTokenUrl(tenant), () =>
    HttpResponse.json({
      token_type: "Bearer",
      scope: "https://ads.microsoft.com/msads.manage",
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: "ms-access",
      refresh_token: "ms-refresh",
      ...over,
    }),
  );

/** POST {base}{path} → JSON body. */
export const msPost = (base: string, path: string, body: unknown) => http.post(`${base}${path}`, () => HttpResponse.json(body as never));

/** AdApiFaultDetail as JSON. // unverified (REST field names mirror the SOAP fault objects) */
export const msAdApiFault = (status: number, code: number, errorCode: string, message: string) =>
  HttpResponse.json({ TrackingId: "trk-1", Type: "AdApiFaultDetail", Errors: [{ Code: code, Detail: null, ErrorCode: errorCode, Message: message }] }, { status });

/** ApiFaultDetail as JSON with OperationErrors. // unverified (REST field names mirror the SOAP fault objects) */
export const msApiFault = (status: number, code: number, errorCode: string, message: string) =>
  HttpResponse.json({ TrackingId: "trk-2", Type: "ApiFaultDetail", BatchErrors: [], OperationErrors: [{ Code: code, Details: null, ErrorCode: errorCode, Message: message }] }, { status });

/** A zipped CSV report as the ReportDownloadUrl serves it. */
export function reportZip(csv: string) {
  return zipSync({ "report.csv": strToU8(csv) });
}

export const REPORT_URL = "https://bingadsappsstorageprod.blob.core.windows.net/download/report-1.zip";

/**
 * Reporting flow: Submit → ReportRequestId; Poll → statuses in order (last one repeats);
 * download → zip of the CSV for the report type in the Submit body.
 */
export function msReporting(csvByType: Record<string, string>, statuses: string[] = ["Success"]) {
  const typeById = new Map<string, string>();
  const polls = new Map<string, number>();
  let seq = 0;
  return [
    http.post(`${MS_REPORTING}/GenerateReport/Submit`, async ({ request }) => {
      const body = (await request.json()) as { ReportRequest: { Type: string } };
      const id = `rr-${++seq}`;
      typeById.set(id, body.ReportRequest.Type);
      return HttpResponse.json({ ReportRequestId: id });
    }),
    http.post(`${MS_REPORTING}/GenerateReport/Poll`, async ({ request }) => {
      const { ReportRequestId: id } = (await request.json()) as { ReportRequestId: string };
      const n = polls.get(id) ?? 0;
      polls.set(id, n + 1);
      const status = statuses[Math.min(n, statuses.length - 1)]!;
      const type = typeById.get(id)!;
      const url = status === "Success" && csvByType[type] != null ? `${REPORT_URL}?id=${id}` : null;
      return HttpResponse.json({ ReportRequestStatus: { ReportDownloadUrl: url, Status: status } });
    }),
    http.get(REPORT_URL, ({ request }) => {
      const id = new URL(request.url).searchParams.get("id")!;
      return new HttpResponse(reportZip(csvByType[typeById.get(id)!]!), { headers: { "Content-Type": "application/x-zip-compressed" } });
    }),
  ];
}

/**
 * Geographic locations file (GetGeoLocationsFileUrl → CSV). Column names per
 * https://learn.microsoft.com/advertising/guides/geographical-location-codes ("Location Id", "Bing Display Name", "Location Type"). // unverified (column order)
 */
export const GEO_FILE_URL = "https://download.api.bingads.microsoft.com/geo/GeoLocations.csv";
export const geoCsv = [
  `"Location Id","Bing Display Name","Location Type","Status"`,
  `"190","India","Country","Active"`,
  `"191","Delhi, Delhi, India","City","Active"`,
  `"244","United States","Country","Active"`,
  `"9999","India Gate, ""Delhi""","PointOfInterest","Active"`,
].join("\r\n");

export const msGeo = () => [
  msPost(MS_CAMPAIGN, "/GeoLocationsFileUrl/Query", { FileUrl: GEO_FILE_URL, FileUrlExpiryTimeUtc: "2026-11-01T00:00:00Z", LastModifiedTimeUtc: "2026-10-01T00:00:00Z" }),
  http.get(GEO_FILE_URL, () => new HttpResponse(geoCsv, { headers: { "Content-Type": "text/csv" } })),
];
