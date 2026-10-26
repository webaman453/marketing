import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, str } from "../builder-values";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface YahooApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
}

export async function yahooCreateCampaign(api: YahooApi, advertiserId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const format = String(draft.setup.format || "DISPLAY");
  const campaign = await api.send<Row>("/campaigns", { advertiserId: Number(advertiserId), name: str(c, "name"), status, goalType: format, budget: budget?.amount, budgetType: budget?.lifetime ? "LIFETIME" : "DAILY" });
  const campaignId = String(campaign.response?.id ?? campaign.id);
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const line = await api.send<Row>("/lines", { campaignId: Number(campaignId), name: str(g.values, "name"), status, budget: budget?.amount, mediaType: format });
    const groupId = String(line.response?.id ?? line.id);
    groups.push({ id: groupId, name: str(g.values, "name"), status, key: g.key });
    for (const ad of g.ads) {
      const made = await api.send<Row>("/ads", {
        lineId: Number(groupId),
        name: str(ad.values, "name"),
        status,
        adType: str(ad.values, "format") || format,
        landingPageUrl: str(ad.values, "url"),
        title: str(ad.values, "headline") || undefined,
        description: str(ad.values, "description") || undefined,
        imageUrl: str(ad.values, "imageUrl") || undefined,
        videoUrl: str(ad.values, "videoUrl") || undefined,
        size: str(ad.values, "size") || undefined,
      });
      ads.push({ id: String(made.response?.id ?? made.id), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "headline"), body: str(ad.values, "description"), url: str(ad.values, "url"), key: ad.key });
    }
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective: format, daily: budget && !budget.lifetime ? budget.amount : null }, groups, ads });
}
