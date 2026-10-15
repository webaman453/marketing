import {
  isVisible,
  levelFields,
  listTexts,
  previewValues,
  type AdPreviewData,
  type BuilderDraft,
  type BuilderIssue,
  type BuilderOptions,
  type CreativeDTO,
  type FieldContext,
  type LevelSpec,
  type PlatformBuilderSpec,
  type PreviewMedia,
  type Values,
} from "@ashniva/shared";

export type Selection = { level: "campaign" } | { level: "adGroup"; key: string } | { level: "ad"; groupKey: string; key: string };

/** Pre-fills account fields (Page, pixel, profile…) with the first option, the way the platforms do. */
export function applyAutoSelect(spec: PlatformBuilderSpec, draft: BuilderDraft, options: BuilderOptions): BuilderDraft {
  const fill = (level: LevelSpec | null, values: Values, ctx: FieldContext) => {
    if (!level) return values;
    let out = values;
    for (const f of levelFields(level)) {
      if (f.type !== "accountOption" || !f.autoSelect || f.multiple || !isVisible(f, ctx)) continue;
      const list = options[f.source] ?? [];
      // Like the platforms, pre-pick the first Page / pixel / profile; people can change it.
      if (!values[f.key] && list.length > 0) out = { ...out, [f.key]: list[0]!.id };
    }
    return out;
  };
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  const campaign = fill(spec.campaign, draft.campaign, base);
  const adSpec = spec.ad(draft.setup);
  return {
    ...draft,
    campaign,
    adGroups: draft.adGroups.map((g) => {
      const values = fill(spec.adGroup, g.values, { ...base, campaign, adGroup: g.values });
      return { ...g, values, ads: g.ads.map((a) => ({ ...a, values: fill(adSpec, a.values, { ...base, campaign, adGroup: values, ad: a.values }) })) };
    }),
  };
}

const IDENTITY: [string, keyof BuilderOptions][] = [
  ["pageId", "pages"],
  ["identityId", "identities"],
  ["profileId", "profiles"],
  ["sender", "profiles"],
  ["organizationId", "organizations"],
];

export function identityName(values: Values, options: BuilderOptions, fallback: string) {
  for (const [key, kind] of IDENTITY) {
    const hit = values[key] ? options[kind]?.find((o) => o.id === values[key]) : undefined;
    if (hit) return hit.name.replace(/\s*\(sample[^)]*\)/i, "");
  }
  return fallback;
}

export function previewDataFor(spec: PlatformBuilderSpec, draft: BuilderDraft, sel: Selection, creatives: CreativeDTO[], options: BuilderOptions, fallbackName: string): { data: AdPreviewData; ctx: FieldContext } {
  const group = (sel.level === "campaign" ? draft.adGroups[0] : draft.adGroups.find((g) => g.key === (sel.level === "ad" ? sel.groupKey : sel.key))) ?? draft.adGroups[0];
  const ad = (sel.level === "ad" ? group?.ads.find((a) => a.key === sel.key) : undefined) ?? group?.ads[0];
  const media: Record<string, PreviewMedia> = Object.fromEntries(creatives.map((c) => [c.id, { id: c.id, url: c.url, type: c.type, width: c.width, height: c.height, name: c.name }]));
  const shown = previewValues(spec, draft, group, ad);
  return {
    data: {
      platform: draft.platform,
      setup: draft.setup,
      ...shown,
      media,
      identity: { name: identityName({ ...shown.campaign, ...shown.ad }, options, fallbackName) },
    },
    ctx: { setup: draft.setup, campaign: draft.campaign, adGroup: group?.values ?? {}, ad: ad?.values ?? {} },
  };
}

/** The ad's current text, given to AI suggestions so new options fit the rest. */
export function adContextOf(values: Values) {
  return Object.entries(values)
    .map(([k, v]) => {
      const t = Array.isArray(v) ? listTexts(v).filter(Boolean).join(" | ") : typeof v === "string" ? v : "";
      return t && !/Id$|^cta$|^format$/.test(k) && !/^https?:/.test(t) ? `${k}: ${t}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export const issuesFor = (issues: BuilderIssue[], sel: Selection) =>
  issues.filter((i) => (sel.level === "campaign" ? i.level === "campaign" || i.level === "setup" : i.nodeKey === sel.key && i.level === sel.level));

/** Every node in editing order: campaign, then each ad group followed by its ads. */
export function nodeOrder(draft: BuilderDraft): Selection[] {
  const out: Selection[] = [{ level: "campaign" }];
  for (const g of draft.adGroups) {
    out.push({ level: "adGroup", key: g.key });
    for (const a of g.ads) out.push({ level: "ad", groupKey: g.key, key: a.key });
  }
  return out;
}

export const sameSelection = (a: Selection, b: Selection) => a.level === b.level && (a.level === "campaign" || (b.level !== "campaign" && a.key === b.key));
