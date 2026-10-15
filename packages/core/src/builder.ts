/**
 * Launches a campaign-builder draft on its ad account and mirrors what was
 * created locally (with ad previews) so it shows up immediately.
 */
import { prisma, type Prisma } from "@ashniva/db";
import {
  BUILDER_SPECS,
  PLATFORM_INFO,
  draftMediaIds,
  isBuilderDraft,
  previewValues,
  validateDraft,
  type AdPreviewData,
  type BuilderDraft,
  type BuilderIssue,
  type BuilderOptions,
  type DraftResult,
  type MediaInfo,
  type PreviewMedia,
  type Values,
} from "@ashniva/shared";
import type { BuilderAsset } from "@ashniva/connectors";
import { audit } from "./audit";
import { connectors } from "./connectors";
import { getFile } from "./storage";
import { upsertStructure } from "./sync";
import { getAccessToken } from "./tokens";

export class DraftInvalidError extends Error {
  constructor(public readonly issues: BuilderIssue[]) {
    super(issues[0]?.message ?? "The campaign isn't complete yet.");
    this.name = "DraftInvalidError";
  }
}

/** Loads a draft's ad account, referenced creatives and validation result. */
export async function inspectDraft(workspaceId: string, payload: unknown) {
  if (!isBuilderDraft(payload)) throw new DraftInvalidError([{ level: "setup", message: "This draft was made with an older builder. Start a new campaign." }]);
  const draft = payload as BuilderDraft;
  const spec = BUILDER_SPECS[draft.platform];
  const [account, creatives] = await Promise.all([
    prisma.adAccount.findFirst({ where: { id: draft.adAccountId, workspaceId }, include: { connection: true } }),
    prisma.creative.findMany({ where: { id: { in: draftMediaIds(spec, draft) }, workspaceId } }),
  ]);
  const media = new Map<string, MediaInfo>(creatives.map((c) => [c.id, { type: c.type, width: c.width, height: c.height }]));
  const issues = validateDraft(spec, draft, media);
  if (!account) issues.unshift({ level: "setup", message: "The ad account for this draft is no longer in this workspace." });
  else if (account.platform !== draft.platform) issues.unshift({ level: "setup", message: "The ad account doesn't match the draft's platform." });
  else if (account.connection.status === "REVOKED") issues.unshift({ level: "setup", message: `${PLATFORM_INFO[account.platform].name} is disconnected. Reconnect it on the Integrations page.` });
  return { draft, spec, account, creatives, issues };
}

const IDENTITY_KEYS: [string, keyof BuilderOptions][] = [
  ["pageId", "pages"],
  ["identityId", "identities"],
  ["profileId", "profiles"],
  ["sender", "profiles"],
  ["organizationId", "organizations"],
];

function identityName(values: Values, options: BuilderOptions | null, fallback: string) {
  for (const [key, kind] of IDENTITY_KEYS) {
    const id = values[key];
    const hit = id ? options?.[kind]?.find((o) => o.id === id) : undefined;
    if (hit) return hit.name.replace(/\s*\(sample[^)]*\)/i, "");
  }
  return String(values.displayName ?? values.brandName ?? values.businessName ?? fallback);
}

export async function launchDraft(draftId: string, userId: string) {
  const row = await prisma.campaignDraft.findUniqueOrThrow({ where: { id: draftId }, include: { workspace: true } });
  const { draft, spec, account, creatives, issues } = await inspectDraft(row.workspaceId, row.payload);
  if (issues.length || !account) throw new DraftInvalidError(issues);

  const connector = connectors().get(account.platform, account.connection.mode);
  if (!connector.createCampaign) throw new DraftInvalidError([{ level: "setup", message: `Creating ${PLATFORM_INFO[account.platform].name} campaigns isn't available yet.` }]);
  if (account.connection.mode === "LIVE") {
    const creatable = spec.apiCreatable?.(draft.setup) ?? true;
    if (creatable !== true) throw new DraftInvalidError([{ level: "setup", message: typeof creatable === "string" ? creatable : "This campaign type can't be created through the platform's API." }]);
  }

  await prisma.campaignDraft.update({ where: { id: draftId }, data: { status: "LAUNCHING" } });
  const base = { adAccountId: account.id, platform: account.platform };

  try {
    const auth = { accessToken: await getAccessToken(account.connection) };
    const ref = { externalId: account.externalId, currency: account.currency, timezone: account.timezone, meta: account.meta as Record<string, unknown> | null };

    const assets = new Map<string, BuilderAsset>(
      creatives.map((c) => {
        const cache = (c.platformAssets as Record<string, { ref: string }> | null) ?? {};
        return [
          c.id,
          {
            creativeId: c.id,
            type: c.type,
            filename: c.name,
            mimeType: c.mimeType,
            width: c.width,
            height: c.height,
            cachedRef: cache[account.id]?.ref,
            load: async () => {
              const file = await getFile(c.storageKey);
              if (!file) throw new Error(`Creative “${c.name}” file is missing.`);
              return file.data;
            },
            onUploaded: async (platformRef: string) => {
              const fresh = await prisma.creative.findUnique({ where: { id: c.id }, select: { platformAssets: true } });
              const next = { ...((fresh?.platformAssets as Record<string, unknown>) ?? {}), [account.id]: { ref: platformRef } };
              await prisma.creative.update({ where: { id: c.id }, data: { platformAssets: next as Prisma.InputJsonValue } });
            },
          },
        ];
      }),
    );

    const structure = await connector.createCampaign(auth, ref, draft, assets);
    const isDemo = account.connection.mode === "DEMO";
    const ids = await upsertStructure(account, structure, isDemo);
    const created = structure.campaigns[0]!;
    const campaignId = ids.campaigns.get(created.externalId);

    // Previews for the campaign detail page.
    const options = connector.getBuilderOptions ? await connector.getBuilderOptions(auth, ref).catch(() => null) : null;
    const media: Record<string, PreviewMedia> = Object.fromEntries(creatives.map((c) => [c.id, { id: c.id, url: c.url, type: c.type, width: c.width, height: c.height, name: c.name }]));
    const fallbackName = row.workspace.name;
    for (const ad of structure.ads) {
      if (!ad.sourceKey) continue;
      const group = draft.adGroups.find((g) => g.key === ad.sourceKey || g.ads.some((a) => a.key === ad.sourceKey));
      if (!group) continue;
      const node = group.ads.find((a) => a.key === ad.sourceKey);
      const shown = previewValues(spec, draft, group, node);
      const preview: AdPreviewData = {
        platform: draft.platform,
        setup: draft.setup,
        ...shown,
        media,
        identity: { name: identityName({ ...shown.campaign, ...shown.ad }, options, fallbackName) },
      };
      await prisma.ad.updateMany({ where: { adAccountId: account.id, externalId: ad.externalId }, data: { preview: preview as unknown as Prisma.InputJsonValue } });
    }

    await audit({
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      userId,
      action: "campaign.created",
      entityType: "campaign",
      entityId: campaignId ?? null,
      entityName: `${created.name} (${PLATFORM_INFO[account.platform].name})`,
      changes: {
        status: { from: null, to: created.status },
        ...(created.dailyBudget != null ? { dailyBudget: { from: null, to: created.dailyBudget } } : {}),
      },
    });

    const result: DraftResult = { ...base, ok: true, campaignId, externalId: created.externalId, created: { adGroups: structure.adGroups.length, ads: structure.ads.length }, ...(structure.warnings?.length ? { warnings: structure.warnings } : {}) };
    return prisma.campaignDraft.update({
      where: { id: draftId },
      data: { status: "LAUNCHED", results: [result] as unknown as Prisma.InputJsonValue, launchedAt: new Date() },
    });
  } catch (err) {
    const result: DraftResult = { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
    return prisma.campaignDraft.update({ where: { id: draftId }, data: { status: "FAILED", results: [result] as unknown as Prisma.InputJsonValue } });
  }
}
