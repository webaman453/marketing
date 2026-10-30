import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, mediaOf, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface OutbrainApi {
  send<T = Row>(path: string, method: "POST" | "PUT", body: unknown): Promise<T>;
}

export async function outbrainCreateCampaign(api: OutbrainApi, marketerId: string, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const countries = countryCodes(c);
  const created = await api.send<Row>(`/marketers/${marketerId}/campaigns`, "POST", {
    name: str(c, "name"),
    enabled: status === "ACTIVE",
    budget: { amount: budget?.amount ?? 1, type: budget?.lifetime ? "LIFETIME" : "DAILY" },
    // The form keeps one bid under `cpc`; its meaning follows bidType.
    ...(str(c, "bidType") === "CPM" ? { bidType: "CPM", cpm: Number(c.cpc ?? 1) } : { cpc: Number(c.cpc ?? 0.3) }),
    objective: String(draft.setup.objective || "Traffic"),
    targeting: { country: countries },
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
        const imageUrl = str(a, "imageUrl") || (await hostedImage(a, assets));
        const link = await api.send<Row>(`/campaigns/${campaignId}/promotedLinks`, "POST", {
          text: str(a, "title"),
          url: str(a, "url"),
          enabled: status === "ACTIVE",
          imageMetadata: { url: imageUrl },
        });
        ads.push({ id: String(link.id), groupId: gid, name: str(a, "name") || str(a, "title"), status, headline: str(a, "title"), url: str(a, "url"), key: ad.key });
      }
    }
    return accountTree({
      campaign: { id: campaignId, name: str(c, "name"), status, objective: String(draft.setup.objective || "Traffic"), daily: budget && !budget.lifetime ? budget.amount : null, lifetime: budget?.lifetime ? budget.amount : null },
      groups,
      ads,
    });
  } catch (err) {
    await api.send(`/campaigns/${campaignId}`, "PUT", { enabled: false }).catch(() => undefined);
    throw err;
  }
}

async function hostedImage(values: BuilderDraft["campaign"], assets: Map<string, BuilderAsset>) {
  const [file] = mediaOf(values, "image", assets);
  if (!file?.cachedRef) throw new ConnectorError("INVALID_REQUEST", "Outbrain needs a public image URL. Paste one, or upload an image that already has a public link.");
  return file.cachedRef;
}
