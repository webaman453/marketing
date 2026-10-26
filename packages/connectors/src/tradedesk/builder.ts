import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, str } from "../builder-values";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface TradeDeskApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
}

export async function tradeDeskCreateCampaign(api: TradeDeskApi, advertiserId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const format = String(draft.setup.format || "DISPLAY");
  const campaign = await api.send<Row>("/campaign", {
    AdvertiserId: advertiserId,
    CampaignName: str(c, "name"),
    Budget: { Amount: budget?.amount ?? 1, CurrencyCode: "USD" },
    StartDate: new Date().toISOString(),
    Availability: status === "ACTIVE" ? "Available" : "Archived",
  });
  const campaignId = String(campaign.CampaignId);
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const creativeIds: string[] = [];
    for (const ad of g.ads) {
      const creative = await api.send<Row>("/creative", {
        AdvertiserId: advertiserId,
        CreativeName: str(ad.values, "name"),
        CreativeType: str(ad.values, "format") || format,
        ClickthroughUrl: str(ad.values, "url"),
        Description: str(ad.values, "description") || undefined,
        ThirdPartyTag: str(ad.values, "tag") || undefined,
        ImageUrl: str(ad.values, "imageUrl") || undefined,
        Countries: countryCodes(g.values),
      });
      const creativeId = String(creative.CreativeId);
      creativeIds.push(creativeId);
      ads.push({ id: creativeId, groupId: "", name: str(ad.values, "name"), status, headline: str(ad.values, "name"), body: str(ad.values, "description"), url: str(ad.values, "url"), key: ad.key });
    }
    const group = await api.send<Row>("/adgroup", {
      CampaignId: campaignId,
      AdGroupName: str(g.values, "name"),
      IsEnabled: status === "ACTIVE",
      RTBAttributes: {
        BudgetSettings: { Budget: { Amount: budget?.amount ?? 1, CurrencyCode: "USD" } },
        CreativeIds: creativeIds,
      },
    });
    const groupId = String(group.AdGroupId);
    groups.push({ id: groupId, name: str(g.values, "name"), status, key: g.key });
    for (const ad of ads) {
      if (!ad.groupId) ad.groupId = groupId;
    }
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective: format, daily: budget?.amount ?? null }, groups, ads });
}
