import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, isoDate, dateOf, mediaOf, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface TaboolaApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
  upload(path: string, file: Buffer, filename: string, mime: string): Promise<Row>;
}

const OBJECTIVE: Record<string, string> = {
  TRAFFIC: "DRIVE_WEBSITE_TRAFFIC",
  LEADS: "LEADS_GENERATION",
  AWARENESS: "BRAND_AWARENESS",
};

export async function taboolaCreateCampaign(api: TaboolaApi, accountId: string, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const countries = countryCodes(c);
  const acct = encodeURIComponent(accountId);
  const created = await api.send<Row>(`/${acct}/campaigns/`, {
    name: str(c, "name"),
    branding_text: str(c, "brand") || str(c, "name"),
    marketing_objective: OBJECTIVE[String(draft.setup.objective)] ?? "DRIVE_WEBSITE_TRAFFIC",
    is_active: status === "ACTIVE",
    daily_cap: budget && !budget.lifetime ? budget.amount : undefined,
    spending_limit: budget?.lifetime ? budget.amount : undefined,
    spending_limit_model: budget?.lifetime ? "MONTHLY" : "NONE",
    country_targeting: countries.length ? { type: "INCLUDE", value: countries } : undefined,
    platform_targeting: strsDevices(c),
    start_date: isoDate(dateOf(c, "startDate")) ?? undefined,
    end_date: isoDate(dateOf(c, "endDate")) ?? undefined,
  });
  const campaignId = String(created.id);
  const groups = [];
  const ads = [];
  try {
    for (const g of draft.adGroups) {
      const gid = `${campaignId}:${g.key}`;
      groups.push({ id: gid, name: str(g.values, "name"), status, key: g.key });
      for (const ad of g.ads) {
        const a = ad.values;
        const thumb = await thumbnail(api, acct, a, assets);
        const item = await api.send<Row>(`/${acct}/campaigns/${campaignId}/items/`, {
          url: str(a, "url"),
          title: str(a, "title"),
          description: str(a, "description") || undefined,
          thumbnail_url: thumb,
        });
        ads.push({ id: String(item.id), groupId: gid, name: str(a, "name") || str(a, "title"), status, headline: str(a, "title"), body: str(a, "description"), url: str(a, "url"), key: ad.key });
      }
    }
    return accountTree({
      campaign: { id: campaignId, name: str(c, "name"), status, objective: String(draft.setup.objective), daily: budget && !budget.lifetime ? budget.amount : null, lifetime: budget?.lifetime ? budget.amount : null, start: isoDate(dateOf(c, "startDate")), end: isoDate(dateOf(c, "endDate")) },
      groups,
      ads,
    });
  } catch (err) {
    await api.send(`/${acct}/campaigns/${campaignId}/`, { is_active: false }).catch(() => undefined);
    throw err;
  }
}

function strsDevices(v: BuilderDraft["campaign"]) {
  const devices = Array.isArray(v.devices) ? (v.devices as string[]) : [];
  if (!devices.length) return undefined;
  return { type: "INCLUDE", value: devices };
}

async function thumbnail(api: TaboolaApi, acct: string, values: BuilderDraft["campaign"], assets: Map<string, BuilderAsset>) {
  if (str(values, "imageUrl")) return str(values, "imageUrl");
  const [file] = mediaOf(values, "image", assets);
  if (!file) throw new ConnectorError("INVALID_REQUEST", "Each Taboola item needs an image.");
  const uploaded = await api.upload(`/${acct}/images/`, await file.load(), file.filename, file.mimeType);
  const url = uploaded.url ?? uploaded.value ?? uploaded.thumbnail_url;
  if (!url) throw new ConnectorError("PLATFORM_ERROR", "Taboola did not return an image URL.");
  await file.onUploaded?.(String(url));
  return String(url);
}
