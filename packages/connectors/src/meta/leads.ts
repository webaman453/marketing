/**
 * Reads Instant Form leads. Leads belong to Facebook Pages, not ad accounts,
 * and are read with each Page's own token (derived from the login's token).
 */
import { ConnectorError, isConnectorError } from "../errors";
import type { ExternalLead } from "../types";

type Rec = Record<string, any>;
type All = (path: string, token: string, query: Record<string, string | number>) => Promise<Rec[]>;
type One = (path: string, token: string, query: Record<string, string | number>) => Promise<Rec>;

/**
 * A Page or form this login cannot read (missing role, removed form) is skipped so it does not
 * block the others; an expired login, rate limit or outage throws so the sync records it
 * instead of silently skipping those leads.
 */
function skipUnlessFatal(err: unknown) {
  if (isConnectorError(err) && (err.code === "PERMISSION_DENIED" || err.code === "INVALID_REQUEST" || err.code === "UNSUPPORTED")) return;
  throw err;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export async function metaFetchLeads(all: All, one: One, userToken: string, since: Date | null): Promise<ExternalLead[]> {
  // Say so plainly when the login was connected before lead access was requested.
  const perms = await one("/me/permissions", userToken, {});
  const granted = new Set((perms.data as Rec[] | undefined)?.filter((p) => p.status === "granted").map((p) => String(p.permission)));
  // Login no longer asks for this until the Meta app has the leads use case. Throw rather than
  // return [] so the sync records it in stats.leadsError and the app can show a reconnect banner.
  if (!granted.has("leads_retrieval")) {
    throw new ConnectorError("PERMISSION_DENIED", "Leads permission not granted. Reconnect Meta and allow lead access to read leads.");
  }

  const pages = await all("/me/accounts", userToken, { fields: "id,name,access_token", limit: 100 });
  const out: ExternalLead[] = [];
  const filtering = since
    ? JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) }])
    : undefined;

  for (const page of pages) {
    const pageToken = str(page.access_token);
    if (!pageToken) continue;
    let forms: Rec[];
    try {
      forms = await all(`/${page.id}/leadgen_forms`, pageToken, { fields: "id,name,status", limit: 100 });
    } catch (err) {
      skipUnlessFatal(err);
      continue; // a Page we cannot read must not block the others
    }
    for (const form of forms) {
      let leads: Rec[];
      try {
        leads = await all(`/${form.id}/leads`, pageToken, {
          fields: "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,platform,is_organic",
          limit: 100,
          ...(filtering ? { filtering } : {}),
        });
      } catch (err) {
        skipUnlessFatal(err);
        continue;
      }
      for (const l of leads) {
        const fields: Record<string, string[]> = {};
        for (const f of (l.field_data as Rec[] | undefined) ?? []) {
          if (f.name) fields[String(f.name)] = ((f.values as unknown[]) ?? []).map(String);
        }
        out.push({
          externalId: String(l.id),
          createdTime: new Date(String(l.created_time)),
          source: str(l.platform),
          isOrganic: l.is_organic === true,
          pageId: String(page.id),
          formId: str(l.form_id) ?? String(form.id),
          formName: str(form.name),
          externalAdId: str(l.ad_id),
          externalAdGroupId: str(l.adset_id),
          externalCampaignId: str(l.campaign_id),
          adName: str(l.ad_name),
          adGroupName: str(l.adset_name),
          campaignName: str(l.campaign_name),
          fields,
        });
      }
    }
  }
  return out;
}
