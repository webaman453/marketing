import type { BuilderDraft, Values } from "@ashniva/shared";
import { budgetOf, splitBudget, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface TradeDeskApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
  /** PUT (e.g. switching an ad group off during rollback). */
  update<T = Row>(path: string, body: unknown): Promise<T>;
}

/** What each creative type needs, checked before anything is created. */
function checkCreative(v: Values, kind: string) {
  const name = str(v, "name") || "Creative";
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new ConnectorError("INVALID_REQUEST", `${name}: ${what}`);
  };
  if (kind === "NATIVE") need(Boolean(str(v, "headline") && str(v, "description") && str(v, "imageUrl")), "native ads need a headline, description and hosted image URL.");
  else if (kind === "VIDEO") need(Boolean(str(v, "tag")), "video ads need a VAST tag or URL.");
  else need(Boolean(str(v, "imageUrl") || str(v, "tag")), "display ads need a hosted image URL or a third-party tag.");
}

function idOf(res: Row, key: string, what: string) {
  const id = res?.[key];
  if (id == null || id === "") throw new ConnectorError("PLATFORM_ERROR", `The Trade Desk did not return an id for the ${what}.`, res);
  return String(id);
}

export async function tradeDeskCreateCampaign(api: TradeDeskApi, advertiserId: string, currency: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const format = String(draft.setup.format || "DISPLAY");
  const money = (amount: number) => ({ Amount: amount, CurrencyCode: currency });
  // Every creative takes the setup's format: the creative form has no format of its own.
  for (const g of draft.adGroups) for (const ad of g.ads) checkCreative(ad.values, format);
  // The campaign is always Available: "Archived" is permanent. A paused launch turns its ad groups off.
  // RISK: unverified whether TTD accepts a campaign with only a DailyBudget and no total Budget.
  const campaign = await api.send<Row>("/campaign", {
    AdvertiserId: advertiserId,
    CampaignName: str(c, "name"),
    ...(budget?.lifetime ? { Budget: money(budget.amount) } : { DailyBudget: money(budget?.amount ?? 1) }),
    StartDate: new Date().toISOString(),
    Availability: "Available",
  });
  const campaignId = idOf(campaign, "CampaignId", "campaign");
  // A budget entered once for the campaign is shared by its ad groups, not copied to each.
  const perGroup = splitBudget(budget?.amount ?? 1, draft.adGroups.length);
  const groups: { id: string; name: string; status: EntityStatus; daily: number | null; key: string }[] = [];
  const ads: Parameters<typeof accountTree>[0]["ads"] = [];
  try {
    for (const g of draft.adGroups) {
      const creativeIds: string[] = [];
      for (const ad of g.ads) {
        const kind = format;
        const tag = str(ad.values, "tag");
        const native = kind === "NATIVE";
        // Locations/devices are draft-only: creative Countries is not targeting, so they are not sent.
        // RISK: creative field names (Headline, ThirdPartyTag for VAST) are not verified against TTD.
        const creative = await api.send<Row>("/creative", {
          AdvertiserId: advertiserId,
          CreativeName: str(ad.values, "name"),
          CreativeType: kind,
          ClickthroughUrl: str(ad.values, "url"),
          Headline: native ? str(ad.values, "headline") : undefined,
          Description: native ? str(ad.values, "description") : undefined,
          ThirdPartyTag: native ? undefined : tag || undefined,
          ImageUrl: kind === "VIDEO" ? undefined : str(ad.values, "imageUrl") || undefined,
        });
        const creativeId = idOf(creative, "CreativeId", "creative");
        creativeIds.push(creativeId);
        ads.push({ id: creativeId, groupId: "", name: str(ad.values, "name"), status, headline: native ? str(ad.values, "headline") : str(ad.values, "name"), body: native ? str(ad.values, "description") : null, url: str(ad.values, "url"), key: ad.key });
      }
      const group = await api.send<Row>("/adgroup", {
        CampaignId: campaignId,
        AdGroupName: str(g.values, "name"),
        IsEnabled: status === "ACTIVE",
        RTBAttributes: {
          BudgetSettings: budget?.lifetime ? { Budget: money(perGroup) } : { DailyBudget: money(perGroup) },
          CreativeIds: creativeIds,
        },
      });
      const groupId = idOf(group, "AdGroupId", "ad group");
      groups.push({ id: groupId, name: str(g.values, "name"), status, daily: budget?.lifetime ? null : perGroup, key: g.key });
      for (const ad of ads) {
        if (!ad.groupId) ad.groupId = groupId;
      }
    }
  } catch (err) {
    // Ad groups created enabled would keep delivering while the caller sees a failure: switch them off.
    if (status === "ACTIVE") {
      for (const g of groups) await api.update("/adgroup", { AdGroupId: g.id, IsEnabled: false }).catch(() => undefined);
    }
    throw err;
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective: format, daily: budget && !budget.lifetime ? budget.amount : null, lifetime: budget?.lifetime ? budget.amount : null }, groups, ads });
}
