import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, str } from "../builder-values";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface XApi {
  send<T = Row>(url: string, body: unknown, form?: boolean): Promise<T>;
}

const ADS = "https://ads-api.x.com/12";

export async function xCreateCampaign(api: XApi, accountId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const entity = status === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const objective = String(draft.setup.objective || "WEBSITE_CLICKS");
  const campaign = await api.send<Row>(`${ADS}/accounts/${accountId}/campaigns`, {
    name: str(c, "name"),
    funding_instrument_id: str(c, "fundingInstrumentId"),
    entity_status: entity,
    daily_budget_amount_local_micro: budget && !budget.lifetime ? Math.round(budget.amount * 1_000_000) : undefined,
    total_budget_amount_local_micro: budget?.lifetime ? Math.round(budget.amount * 1_000_000) : undefined,
  }, true);
  const campaignId = String(campaign.data?.id ?? campaign.id);
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const line = await api.send<Row>(`${ADS}/accounts/${accountId}/line_items`, {
      campaign_id: campaignId,
      name: str(g.values, "name"),
      entity_status: entity,
      objective,
      product_type: "PROMOTED_TWEETS",
      placements: ["ALL_ON_TWITTER"],
      bid_amount_local_micro: Number(g.values.bidAmount ?? 0) > 0 ? Math.round(Number(g.values.bidAmount) * 1_000_000) : undefined,
      goal: objective === "VIDEO_VIEWS" ? "VIDEO_VIEW" : "LINK_CLICKS",
    }, true);
    const groupId = String(line.data?.id ?? line.id);
    groups.push({ id: groupId, name: str(g.values, "name"), status, bid: str(g.values, "bidAmount"), key: g.key });
    for (const ad of g.ads) {
      const text = [str(ad.values, "text"), str(ad.values, "url")].filter(Boolean).join("\n");
      const tweet = await api.send<Row>("https://api.x.com/2/tweets", { text });
      const tweetId = String(tweet.data?.id ?? tweet.id);
      const promoted = await api.send<Row>(`${ADS}/accounts/${accountId}/promoted_tweets`, { line_item_id: groupId, tweet_ids: tweetId }, true);
      const adId = String(promoted.data?.[0]?.id ?? promoted.data?.id ?? tweetId);
      ads.push({ id: adId, groupId, name: str(ad.values, "name") || text.slice(0, 40), status, body: str(ad.values, "text"), url: str(ad.values, "url"), key: ad.key });
    }
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective, daily: budget && !budget.lifetime ? budget.amount : null, lifetime: budget?.lifetime ? budget.amount : null },
    groups,
    ads,
  });
}
