import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface CriteoApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
  /** Starts or stops ad sets (POST /marketing-solutions/ad-sets/start | stop). */
  setStatus(ids: string[], status: "ACTIVE" | "PAUSED"): Promise<void>;
}

export async function criteoCreateCampaign(api: CriteoApi, advertiserId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const goal = String(draft.setup.goal || "RETARGETING");
  // One ad set per campaign (the form allows one); its ads all go on that ad set.
  const group = draft.adGroups[0];
  if (!group) throw new ConnectorError("INVALID_REQUEST", "A Criteo campaign needs an ad set.");
  if (draft.adGroups.length > 1) throw new ConnectorError("INVALID_REQUEST", "Criteo campaigns made here have one ad set.");
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
  const groupId = idOf(created, "ad set");
  const campaignId = String(created.data?.attributes?.campaignId ?? groupId);
  const ads = [];
  try {
    for (const ad of group.ads) {
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
      ads.push({ id: idOf(made, "ad"), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "headline"), body: str(ad.values, "description"), url: str(ad.values, "url"), key: ad.key });
    }
  } catch (err) {
    // A live ad set whose ads failed would deliver what was made so far: stop it before reporting the failure.
    if (status === "ACTIVE") await api.setStatus([groupId], "PAUSED").catch(() => undefined);
    throw err;
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective: goal, daily: budget && !budget.lifetime ? budget.amount : null, raw: { adSetIds: [groupId] } },
    groups: [{ id: groupId, name: str(group.values, "name") || str(c, "name"), status, key: group.key }],
    ads,
  });
}

function idOf(res: Row, what: string) {
  const id = res?.data?.id ?? res?.id;
  if (id == null || id === "") throw new ConnectorError("PLATFORM_ERROR", `Criteo did not return an id for the ${what}.`, res);
  return String(id);
}
