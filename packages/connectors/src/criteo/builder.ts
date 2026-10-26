import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, str } from "../builder-values";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface CriteoApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
}

export async function criteoCreateCampaign(api: CriteoApi, advertiserId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const goal = String(draft.setup.goal || "RETARGETING");
  const created = await api.send<Row>(`/advertisers/${advertiserId}/ad-sets`, {
    data: {
      type: "AdSet",
      attributes: {
        name: str(c, "name"),
        status,
        goal,
        budget: { amount: budget?.amount ?? 1, type: budget?.lifetime ? "LIFETIME" : "DAILY" },
        geo: countryCodes(c),
      },
    },
  });
  const groupId = String(created.data?.id ?? created.id);
  const campaignId = String(created.data?.attributes?.campaignId ?? groupId);
  const ads = [];
  for (const g of draft.adGroups) {
    for (const ad of g.ads) {
      const made = await api.send<Row>(`/ad-sets/${groupId}/ads`, {
        data: {
          type: "Ad",
          attributes: {
            name: str(ad.values, "name"),
            format: str(ad.values, "format") || "DISPLAY",
            headline: str(ad.values, "headline"),
            description: str(ad.values, "description"),
            clickUrl: str(ad.values, "url"),
            imageUrl: str(ad.values, "imageUrl") || undefined,
          },
        },
      });
      ads.push({ id: String(made.data?.id ?? made.id), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "headline"), body: str(ad.values, "description"), url: str(ad.values, "url"), key: ad.key });
    }
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective: goal, daily: budget && !budget.lifetime ? budget.amount : null },
    groups: draft.adGroups.map((g) => ({ id: groupId, name: str(g.values, "name") || str(c, "name"), status, key: g.key })),
    ads,
  });
}
