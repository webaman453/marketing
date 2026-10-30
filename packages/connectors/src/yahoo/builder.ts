import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, splitBudget, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface YahooApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
  update<T = Row>(path: string, body: unknown): Promise<T>;
}

function idOf(res: Row, what: string) {
  const id = res?.response?.id ?? res?.id;
  if (id == null || id === "") throw new ConnectorError("PLATFORM_ERROR", `Yahoo DSP did not return an id for the ${what}.`, res);
  return String(id);
}

export async function yahooCreateCampaign(api: YahooApi, advertiserId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const format = String(draft.setup.format || "DISPLAY");
  // The campaign names its advertiser with `accountId`.
  const campaign = await api.send<Row>("/campaigns", { accountId: Number(advertiserId), name: str(c, "name"), status, goalType: format, budget: budget?.amount, budgetType: budget?.lifetime ? "LIFETIME" : "DAILY" });
  const campaignId = idOf(campaign, "campaign");
  try {
    return await buildLines(api, draft, campaignId, status, format, budget);
  } catch (err) {
    // The Traffic API cannot delete a campaign; INACTIVE takes the half-built one out of delivery for good.
    await api.update(`/campaigns/${campaignId}`, { status: "INACTIVE" }).catch(() => undefined);
    throw err;
  }
}

async function buildLines(api: YahooApi, draft: BuilderDraft, campaignId: string, status: EntityStatus, format: string, budget: ReturnType<typeof budgetOf>): Promise<AccountStructure> {
  const c = draft.campaign;
  // The campaign budget is shared by its lines, not copied to each.
  const perLine = budget ? splitBudget(budget.amount, draft.adGroups.length) : undefined;
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const line = await api.send<Row>("/lines", { campaignId: Number(campaignId), name: str(g.values, "name"), status, budget: perLine, mediaType: format });
    const groupId = idOf(line, "line");
    groups.push({ id: groupId, name: str(g.values, "name"), status, daily: budget && !budget.lifetime ? perLine : null, key: g.key });
    for (const ad of g.ads) {
      const made = await api.send<Row>("/ads", {
        lineId: Number(groupId),
        name: str(ad.values, "name"),
        status,
        // Every ad takes the setup's format: the ad form has no format of its own.
        adType: format,
        landingPageUrl: str(ad.values, "url"),
        title: str(ad.values, "headline") || undefined,
        description: str(ad.values, "description") || undefined,
        imageUrl: str(ad.values, "imageUrl") || undefined,
        videoUrl: str(ad.values, "videoUrl") || undefined,
        size: str(ad.values, "size") || undefined,
      });
      ads.push({ id: idOf(made, "ad"), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "headline"), body: str(ad.values, "description"), url: str(ad.values, "url"), key: ad.key });
    }
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective: format, daily: budget && !budget.lifetime ? budget.amount : null }, groups, ads });
}
