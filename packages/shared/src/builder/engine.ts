/**
 * Spec-driven helpers shared by the web form and the API: defaults,
 * visibility, and validation of a whole draft.
 */
import type {
  AdGroupNode,
  AdNode,
  BuilderDraft,
  BuilderIssue,
  Field,
  FieldContext,
  IssueLevel,
  KeywordValue,
  LevelSpec,
  Option,
  PlatformBuilderSpec,
  SetupChoice,
  TextListField,
  Values,
} from "./types";

export const emptyContext = (): FieldContext => ({ setup: {}, campaign: {}, adGroup: {}, ad: {} });

export const setupOptions = (choice: SetupChoice, setup: Values) => (typeof choice.options === "function" ? choice.options(setup) : choice.options);

export const resolveOptions = (field: { options: Option[] | ((ctx: FieldContext) => Option[]) }, ctx: FieldContext) =>
  typeof field.options === "function" ? field.options(ctx) : field.options;

export const isRequired = (field: Field, ctx: FieldContext) =>
  typeof field.required === "function" ? field.required(ctx) : Boolean(field.required);

export const isVisible = (field: { showIf?: (ctx: FieldContext) => boolean }, ctx: FieldContext) => !field.showIf || field.showIf(ctx);

/** Text values of a text list, accepting both plain strings and pinned items. */
export function listTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v : typeof v === "object" && v ? String((v as { text?: unknown }).text ?? "") : "")).map((s) => s.trim());
}

export function defaultValue(field: Field, ctx: FieldContext): unknown {
  switch (field.type) {
    case "text":
    case "textarea":
    case "url":
      return field.default ?? "";
    case "textList":
      return Array.from({ length: field.initial ?? Math.max(1, field.min) }, () => (field.pinnable ? { text: "", pin: null } : ""));
    case "number":
    case "money":
    case "percent":
      return field.default ?? null;
    case "select":
    case "radio":
    case "cards":
    case "segmented": {
      if (field.default !== undefined) return typeof field.default === "function" ? field.default(ctx) : field.default;
      return field.type === "select" ? "" : (resolveOptions(field, ctx)[0]?.value ?? "");
    }
    case "multiSelect":
    case "chips":
    case "checkboxes":
      return field.default ?? [];
    case "toggle":
      return field.default ?? false;
    case "date":
    case "datetime":
      return null;
    case "accountOption":
      return field.multiple ? [] : "";
    case "targeting":
      return field.default ?? [];
    case "keywords":
      return [];
    case "ageRange":
      return field.default ?? { min: field.min, max: field.max };
    case "placements":
      return { mode: "AUTO", items: field.groups.flatMap((g) => g.items.map((i) => i.value)) };
    case "media":
      return [];
    case "repeater":
      return Array.from({ length: field.min }, () => levelValues(field.fields, ctx));
    case "adSchedule":
      return { days: {} };
    case "info":
      return undefined;
  }
}

function levelValues(fields: Field[], ctx: FieldContext): Values {
  const out: Values = {};
  for (const f of fields) {
    if (f.type === "info") continue;
    out[f.key] = defaultValue(f, ctx);
  }
  return out;
}

export const levelFields = (level: LevelSpec) => level.sections.flatMap((s) => s.fields);

/** Drops values of fields the current choices hide, e.g. carousel cards on a single-image ad. */
export function visibleValues(level: LevelSpec | null, values: Values, ctx: FieldContext): Values {
  if (!level) return values;
  const shown = new Set<string>();
  const hidden = new Set<string>();
  for (const s of level.sections) {
    const sectionShown = isVisible(s, ctx);
    for (const f of s.fields) (sectionShown && isVisible(f, ctx) ? shown : hidden).add(f.key);
  }
  const out = { ...values };
  for (const k of hidden) if (!shown.has(k)) delete out[k];
  return out;
}

/** The values an ad's preview should use: only what the form currently shows at each level. */
export function previewValues(spec: PlatformBuilderSpec, draft: BuilderDraft, group: AdGroupNode | undefined, ad: AdNode | undefined) {
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: group?.values ?? {}, ad: ad?.values ?? {} };
  const adSpec = spec.ad(draft.setup);
  return {
    campaign: visibleValues(spec.campaign, draft.campaign, base),
    adGroup: group ? visibleValues(spec.adGroup, group.values, base) : {},
    // Platforms without an ad level keep the creative on the ad group.
    ad: ad && adSpec ? visibleValues(adSpec, ad.values, base) : group ? visibleValues(spec.adGroup, group.values, base) : {},
  };
}

/** Default values for one level, given what's already chosen above it. */
export function levelDefaults(level: LevelSpec, ctx: FieldContext): Values {
  return levelValues(levelFields(level), ctx);
}

/** Fills in keys added to a spec after a draft was saved. */
export function withDefaults(level: LevelSpec, values: Values, ctx: FieldContext): Values {
  const out = { ...values };
  for (const f of levelFields(level)) {
    if (f.type !== "info" && !(f.key in out)) out[f.key] = defaultValue(f, { ...ctx });
  }
  return out;
}

let keySeq = 0;
export const nodeKey = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(keySeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A brand-new draft for a platform after the start-screen choices. */
export function newDraft(spec: PlatformBuilderSpec, adAccountId: string, setup: Values, name = ""): BuilderDraft {
  const draft: BuilderDraft = {
    version: 2,
    platform: spec.platform,
    adAccountId,
    setup,
    campaign: { ...levelDefaults(spec.campaign, { setup, campaign: {}, adGroup: {}, ad: {} }), name },
    adGroups: [],
  };
  draft.adGroups.push(newAdGroup(spec, draft));
  return draft;
}

/** A new ad set / ad group with one ad, named like the platforms do ("Ad set 2"). */
export function newAdGroup(spec: PlatformBuilderSpec, draft: BuilderDraft): AdGroupNode {
  const ctx: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  const values = { ...levelDefaults(spec.adGroup, ctx), name: `${spec.adGroup.label} ${draft.adGroups.length + 1}` };
  const group: AdGroupNode = { key: nodeKey("g"), values, ads: [] };
  const ad = newAd(spec, draft, group);
  if (ad) group.ads.push(ad);
  return group;
}

export function newAd(spec: PlatformBuilderSpec, draft: BuilderDraft, group: AdGroupNode): AdNode | null {
  const adSpec = spec.ad(draft.setup);
  if (!adSpec) return null;
  const ctx: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: group.values, ad: {} };
  return { key: nodeKey("a"), values: { ...levelDefaults(adSpec, ctx), name: `${adSpec.label} ${group.ads.length + 1}` } };
}

// ───────── Validation ─────────

export interface MediaInfo {
  type: "IMAGE" | "VIDEO";
  width: number | null;
  height: number | null;
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*\.[^\s]{2,}/i;

const ratioOf = (r: string) => {
  const [a, b] = r.split(":").map(Number);
  return a && b ? a / b : null;
};

function fieldIssues(field: Field, value: unknown, ctx: FieldContext, media: Map<string, MediaInfo>, prefix = ""): string[] {
  const label = `${prefix}${field.label}`;
  const issues: string[] = [];
  const required = isRequired(field, ctx);

  switch (field.type) {
    case "text":
    case "textarea":
    case "url": {
      const s = typeof value === "string" ? value.trim() : "";
      if (!s) {
        if (required) issues.push(`${label} is required.`);
        break;
      }
      if (field.maxLength && s.length > field.maxLength) issues.push(`${label} is over ${field.maxLength} characters.`);
      if (field.minLength && s.length < field.minLength) issues.push(`${label} needs at least ${field.minLength} characters.`);
      if (field.type === "url" && !URL_RE.test(s)) issues.push(`${label} must be a full URL starting with https://`);
      break;
    }
    case "textList": {
      const texts = listTexts(value).filter(Boolean);
      const f = field as TextListField;
      if (texts.length < f.min && (required || texts.length > 0 || f.min > 0)) {
        issues.push(f.min === 1 ? `Add at least one ${f.itemLabel.toLowerCase()}.` : `Add at least ${f.min} ${f.itemLabel.toLowerCase()}s.`);
      }
      if (texts.length > f.max) issues.push(`Use at most ${f.max} ${f.itemLabel.toLowerCase()}s.`);
      texts.forEach((t, i) => {
        if (t.length > f.maxLength) issues.push(`${f.itemLabel} ${i + 1} is over ${f.maxLength} characters.`);
      });
      const dupes = texts.filter((t, i) => texts.findIndex((x) => x.toLowerCase() === t.toLowerCase()) !== i);
      if (dupes.length) issues.push(`${f.itemLabel}s must be different from each other.`);
      break;
    }
    case "number":
    case "money":
    case "percent": {
      const n = typeof value === "number" ? value : value === "" || value == null ? null : Number(value);
      if (n == null || Number.isNaN(n)) {
        if (required) issues.push(`${label} is required.`);
        break;
      }
      if (field.min != null && n < field.min) issues.push(`${label} must be at least ${field.min}.`);
      if (field.max != null && n > field.max) issues.push(`${label} must be at most ${field.max}.`);
      break;
    }
    case "select":
    case "radio":
    case "cards":
    case "segmented":
    case "accountOption":
    case "date":
    case "datetime":
      if (required && isEmpty(value)) issues.push(`${label} is required.`);
      break;
    case "multiSelect":
    case "chips":
    case "checkboxes": {
      const list = Array.isArray(value) ? value : [];
      if (required && list.length === 0) issues.push(`Choose at least one ${label.toLowerCase()}.`);
      if (field.min && list.length < field.min && list.length > 0) issues.push(`Choose at least ${field.min} for ${label.toLowerCase()}.`);
      if (field.max && list.length > field.max) issues.push(`Choose at most ${field.max} for ${label.toLowerCase()}.`);
      break;
    }
    case "targeting": {
      const list = Array.isArray(value) ? value : [];
      const included = list.filter((v) => !(v as { exclude?: boolean }).exclude);
      if (required && included.length === 0) issues.push(`Add at least one ${label.toLowerCase()}.`);
      if (field.max && list.length > field.max) issues.push(`Use at most ${field.max} ${label.toLowerCase()}.`);
      break;
    }
    case "keywords": {
      const list = (Array.isArray(value) ? value : []) as KeywordValue[];
      if ((required || (field.min ?? 0) > 0) && list.length < Math.max(1, field.min ?? 1)) {
        issues.push(field.negative ? `Add at least one negative keyword.` : `Add at least ${Math.max(1, field.min ?? 1)} keyword${(field.min ?? 1) > 1 ? "s" : ""}.`);
      }
      if (list.length > field.max) issues.push(`Use at most ${field.max} keywords.`);
      const long = list.find((k) => k.text.length > 80);
      if (long) issues.push(`Keyword “${long.text.slice(0, 20)}…” is too long (80 characters max).`);
      break;
    }
    case "ageRange": {
      const v = value as { min: number; max: number } | undefined;
      if (v && v.min > v.max) issues.push("Minimum age must be below the maximum age.");
      break;
    }
    case "placements": {
      const v = value as { mode: string; items: string[] } | undefined;
      if (v?.mode === "MANUAL" && v.items.length === 0) issues.push("Choose at least one placement, or switch to automatic placements.");
      break;
    }
    case "media": {
      const ids = (Array.isArray(value) ? value : []) as string[];
      const known = ids.map((id) => media.get(id)).filter((m): m is MediaInfo => Boolean(m));
      const min = required ? Math.max(1, field.min) : field.min;
      if (known.length < min) {
        const what = field.accept.length === 1 ? (field.accept[0] === "VIDEO" ? "a video" : "an image") : "an image or video";
        issues.push(min === 1 ? `${label}: add ${what}.` : `${label}: add at least ${min} files.`);
      }
      if (known.length > field.max) issues.push(`Use at most ${field.max} files for ${label.toLowerCase()}.`);
      if (known.some((m) => !field.accept.includes(m.type))) {
        issues.push(`${label} only accepts ${field.accept.map((a) => a.toLowerCase() + "s").join(" or ")}.`);
      }
      const need = field.requiredRatio ? ratioOf(field.requiredRatio) : null;
      if (need && known.some((m) => m.width && m.height && Math.abs(m.width / m.height - need) > 0.03)) {
        issues.push(`${label} must be ${field.requiredRatio}.`);
      }
      break;
    }
    case "repeater": {
      const items = (Array.isArray(value) ? value : []) as Values[];
      const filled = items.filter((it) => field.fields.some((f) => !isEmpty(it[f.key])));
      if (filled.length < field.min && (required || filled.length > 0)) issues.push(`Add at least ${field.min} ${field.itemLabel.toLowerCase()}s.`);
      if (filled.length > field.max) issues.push(`Use at most ${field.max} ${field.itemLabel.toLowerCase()}s.`);
      filled.forEach((it, i) => {
        for (const f of field.fields) issues.push(...fieldIssues(f, it[f.key], ctx, media, `${field.itemLabel} ${i + 1}: `));
      });
      break;
    }
    default:
      break;
  }
  return issues;
}

function levelIssues(level: LevelSpec, values: Values, ctx: FieldContext, media: Map<string, MediaInfo>, where: Omit<BuilderIssue, "message" | "field">) {
  const out: BuilderIssue[] = [];
  for (const section of level.sections) {
    if (!isVisible(section, ctx)) continue;
    for (const field of section.fields) {
      if (field.type === "info" || !isVisible(field, ctx)) continue;
      for (const message of fieldIssues(field, values[field.key], ctx, media)) out.push({ ...where, field: field.key, message });
    }
  }
  return out;
}

/** Every problem in a draft, tagged with where it is so the UI can jump to it. */
export function validateDraft(spec: PlatformBuilderSpec, draft: BuilderDraft, media: Map<string, MediaInfo>): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  for (const choice of spec.setup) {
    if (choice.showIf && !choice.showIf(draft.setup)) continue;
    const allowed = (typeof choice.options === "function" ? choice.options(draft.setup) : choice.options).map((o) => o.value);
    if (!draft.setup[choice.key] || !allowed.includes(String(draft.setup[choice.key]))) issues.push({ level: "setup", field: choice.key, message: `Choose ${choice.label.toLowerCase()}.` });
  }
  issues.push(...levelIssues(spec.campaign, draft.campaign, base, media, { level: "campaign" }));

  const adSpec = spec.ad(draft.setup);
  if (draft.adGroups.length === 0) issues.push({ level: "campaign", message: `Add at least one ${spec.adGroup.label.toLowerCase()}.` });
  if (draft.adGroups.length > spec.maxAdGroups) issues.push({ level: "campaign", message: `Use at most ${spec.maxAdGroups} ${spec.adGroup.label.toLowerCase()}s.` });
  for (const g of draft.adGroups) {
    const gctx = { ...base, adGroup: g.values };
    issues.push(...levelIssues(spec.adGroup, g.values, gctx, media, { level: "adGroup", nodeKey: g.key }));
    if (!adSpec) continue;
    if (g.ads.length === 0) issues.push({ level: "adGroup", nodeKey: g.key, message: `Add at least one ${adSpec.label.toLowerCase()}.` });
    if (g.ads.length > spec.maxAds) issues.push({ level: "adGroup", nodeKey: g.key, message: `Use at most ${spec.maxAds} ${adSpec.label.toLowerCase()}s per ${spec.adGroup.label.toLowerCase()}.` });
    for (const a of g.ads) issues.push(...levelIssues(adSpec, a.values, { ...gctx, ad: a.values }, media, { level: "ad", nodeKey: a.key }));
  }
  issues.push(...(spec.validate?.(draft) ?? []));
  return issues;
}

export const issuesAt = (issues: BuilderIssue[], level: IssueLevel, nodeKey?: string) =>
  issues.filter((i) => i.level === level && (nodeKey === undefined || i.nodeKey === nodeKey));

export function isBuilderDraft(v: unknown): v is BuilderDraft {
  const d = v as BuilderDraft | null;
  return Boolean(d && d.version === 2 && typeof d.platform === "string" && Array.isArray(d.adGroups));
}

/** Every creative-library id referenced by media fields in a draft. */
export function draftMediaIds(spec: PlatformBuilderSpec, draft: BuilderDraft): string[] {
  const ids = new Set<string>();
  const walk = (fields: Field[], values: Values) => {
    for (const f of fields) {
      if (f.type === "media") for (const id of Array.isArray(values[f.key]) ? (values[f.key] as unknown[]) : []) ids.add(String(id));
      if (f.type === "repeater") for (const item of Array.isArray(values[f.key]) ? (values[f.key] as Values[]) : []) walk(f.fields, item ?? {});
    }
  };
  walk(levelFields(spec.campaign), draft.campaign);
  const adSpec = spec.ad(draft.setup);
  for (const g of draft.adGroups) {
    walk(levelFields(spec.adGroup), g.values);
    if (adSpec) for (const a of g.ads) walk(levelFields(adSpec), a.values);
  }
  return [...ids];
}
