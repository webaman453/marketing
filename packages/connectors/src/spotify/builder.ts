import type { BuilderDraft } from "@ashniva/shared";
import type { Values } from "@ashniva/shared";
import { budgetOf, countryCodes, splitBudget, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
export interface SpotifyApi {
  send<T = Row>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T>;
}

/** The creative file for the ad's format: audio spot, video, or display image. */
const ASSET_KEY: Record<string, string> = { AUDIO: "audioUrl", VIDEO: "videoUrl", DISPLAY: "imageUrl" };
/** Companion image (audio) or thumbnail (video). */
const COMPANION_KEY: Record<string, string> = { AUDIO: "companionUrl", VIDEO: "thumbnailUrl" };

function idOf(res: Row, what: string) {
  const id = res?.id;
  if (id == null || id === "") throw new ConnectorError("PLATFORM_ERROR", `Spotify did not return an id for the ${what}.`, res);
  return String(id);
}

function assetsFor(v: Values, format: string) {
  const key = ASSET_KEY[format];
  if (!key) throw new ConnectorError("INVALID_REQUEST", `Spotify ad format "${format}" is not supported.`);
  const asset = str(v, key);
  if (!asset) throw new ConnectorError("INVALID_REQUEST", `The ${format.toLowerCase()} ad "${str(v, "name")}" needs its file URL.`);
  const companion = COMPANION_KEY[format];
  return { asset_url: asset, companion_image_url: companion ? str(v, companion) || undefined : undefined };
}

export async function spotifyCreateCampaign(api: SpotifyApi, accountId: string, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const objective = String(draft.setup.objective || "CLICKS");
  if (!budget) throw new ConnectorError("INVALID_REQUEST", "Set a daily budget for the Spotify campaign.");
  // Check every creative before anything is created on Spotify.
  for (const g of draft.adGroups) {
    for (const ad of g.ads) assetsFor(ad.values, str(ad.values, "format") || "AUDIO");
  }
  const campaign = await api.send<Row>(`/ad_accounts/${accountId}/campaigns`, "POST", { name: str(c, "name"), objective, status });
  const campaignId = idOf(campaign, "campaign");
  try {
    return await buildSets(api, accountId, draft, campaignId, status, objective, budget);
  } catch (err) {
    // Archive the half-built campaign (Spotify has no delete) so nothing is left behind to switch on by mistake.
    await api.send(`/ad_accounts/${accountId}/campaigns/${campaignId}`, "PATCH", { status: "ARCHIVED" }).catch(() => undefined);
    throw err;
  }
}

async function buildSets(api: SpotifyApi, accountId: string, draft: BuilderDraft, campaignId: string, status: EntityStatus, objective: string, budget: { amount: number; lifetime: boolean }): Promise<AccountStructure> {
  const c = draft.campaign;
  // A budget entered once for the campaign is shared by its ad sets, not copied to each.
  const perSet = splitBudget(budget.amount, draft.adGroups.length);
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const set = await api.send<Row>(`/ad_accounts/${accountId}/ad_sets`, "POST", {
      campaign_id: campaignId,
      name: str(g.values, "name"),
      status,
      budget: { micro_amount: Math.round(perSet * 1_000_000), type: budget.lifetime ? "LIFETIME" : "DAILY" },
      targets: { countries: countryCodes(g.values).length ? countryCodes(g.values) : countryCodes(c) },
    });
    const groupId = idOf(set, "ad set");
    groups.push({ id: groupId, name: str(g.values, "name"), status, daily: budget.lifetime ? null : perSet, key: g.key });
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
          ...assetsFor(ad.values, format),
        },
      });
      ads.push({ id: idOf(made, "ad"), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "headline"), body: str(ad.values, "tagline"), url: str(ad.values, "url"), key: ad.key });
    }
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective, daily: budget.lifetime ? null : budget.amount }, groups, ads });
}
