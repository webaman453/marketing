import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, str } from "../builder-values";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface SpotifyApi {
  send<T = Row>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T>;
}

export async function spotifyCreateCampaign(api: SpotifyApi, accountId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const objective = String(draft.setup.objective || "CLICKS");
  const campaign = await api.send<Row>(`/ad_accounts/${accountId}/campaigns`, "POST", { name: str(c, "name"), objective, status });
  const campaignId = String(campaign.id);
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const set = await api.send<Row>(`/ad_accounts/${accountId}/ad_sets`, "POST", {
      campaign_id: campaignId,
      name: str(g.values, "name"),
      status,
      budget: { micro_amount: Math.round((budget?.amount ?? Number(g.values.budget ?? 1)) * 1_000_000), type: budget?.lifetime ? "LIFETIME" : "DAILY" },
      targets: { countries: countryCodes(g.values).length ? countryCodes(g.values) : countryCodes(c) },
    });
    const groupId = String(set.id);
    groups.push({ id: groupId, name: str(g.values, "name"), status, key: g.key });
    for (const ad of g.ads) {
      const format = str(ad.values, "format") || "AUDIO";
      const made = await api.send<Row>(`/ad_accounts/${accountId}/ads`, "POST", {
        ad_set_id: groupId,
        name: str(ad.values, "name"),
        status,
        format,
        assets: {
          headline: str(ad.values, "headline") || undefined,
          tagline: str(ad.values, "tagline") || undefined,
          click_url: str(ad.values, "url") || undefined,
          companion_image_url: str(ad.values, "companionUrl") || str(ad.values, "thumbnailUrl") || undefined,
          asset_url: str(ad.values, "audioUrl") || str(ad.values, "videoUrl") || str(ad.values, "imageUrl") || undefined,
        },
      });
      ads.push({ id: String(made.id), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "headline"), body: str(ad.values, "tagline"), url: str(ad.values, "url"), key: ad.key });
    }
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective, daily: budget && !budget.lifetime ? budget.amount : null }, groups, ads });
}
