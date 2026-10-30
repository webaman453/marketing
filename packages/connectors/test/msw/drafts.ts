/**
 * Realistic builder drafts built from the real BUILDER_SPECS with newDraft, the
 * way the web builder makes them, then every required visible field filled in.
 */
import {
  BUILDER_SPECS,
  isVisible,
  newAdGroup,
  newDraft,
  type BuilderDraft,
  type Field,
  type FieldContext,
  type Platform,
  type Values,
} from "@ashniva/shared";
import type { BuilderAsset } from "../../src/types";

function placeholder(field: Field): unknown {
  if (field.type === "url" || field.key.toLowerCase().includes("url")) return "https://shop.example.com/festive";
  if (field.type === "keywords") return [{ text: "silk saree", matchType: "EXACT" }];
  if (field.type === "targeting") return [{ id: "IN", name: "India", type: "country" }];
  if (field.key === "adamId") return "1234567890";
  if (field.key === "asin" || field.key === "sku") return "B0TESTASIN";
  if (field.key === "asins") return "B0TESTASIN\nB0TESTASI2";
  if (field.type === "textarea" || field.type === "text") return field.key === "text" ? "The festive edit is live" : "Festive edit";
  return "Festive edit";
}

type Level = { sections: { showIf?: (ctx: FieldContext) => boolean; fields: Field[] }[] };

function fillLevel(level: Level, values: Values, ctx: FieldContext) {
  for (const section of level.sections) {
    if (!isVisible(section, ctx)) continue;
    for (const field of section.fields) {
      if (field.type === "info" || !isVisible(field, ctx)) continue;
      if (field.type === "money" || field.type === "number") {
        if (values[field.key] == null || values[field.key] === "") values[field.key] = Math.max(field.min ?? 1, 25);
        continue;
      }
      const v = values[field.key];
      const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
      const required = typeof field.required === "function" ? field.required(ctx) : field.required;
      if (required && empty) values[field.key] = placeholder(field);
    }
  }
}

export interface DraftOptions {
  setup?: Values;
  campaign?: Values;
  adGroup?: Values;
  ad?: Values;
  /** Number of ad groups (default 1). */
  groups?: number;
}

/** A complete draft for a platform; overrides are applied before the required fields are filled. */
export function makeDraft(platform: Platform, setup: Values, opts: Omit<DraftOptions, "setup"> = {}): BuilderDraft {
  const spec = BUILDER_SPECS[platform];
  const draft = newDraft(spec, "acct-1", setup, "Festive Sale");
  for (let i = 1; i < (opts.groups ?? 1); i++) draft.adGroups.push(newAdGroup(spec, draft));
  Object.assign(draft.campaign, opts.campaign ?? {});
  const base: FieldContext = { setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  fillLevel(spec.campaign as Level, draft.campaign, base);
  const adSpec = spec.ad(setup);
  for (const g of draft.adGroups) {
    Object.assign(g.values, opts.adGroup ?? {});
    const gctx = { ...base, adGroup: g.values };
    fillLevel(spec.adGroup as Level, g.values, gctx);
    if (!adSpec) continue;
    for (const a of g.ads) {
      Object.assign(a.values, opts.ad ?? {});
      fillLevel(adSpec as Level, a.values, { ...gctx, ad: a.values });
    }
  }
  return draft;
}

/** A creative-library image the builder hands to createCampaign. */
export function imageAsset(id = "img-1", over: Partial<BuilderAsset> = {}): BuilderAsset {
  return {
    creativeId: id,
    type: "IMAGE",
    filename: `${id}.jpg`,
    mimeType: "image/jpeg",
    width: 1200,
    height: 628,
    load: async () => Buffer.from("fake-jpeg-bytes"),
    ...over,
  };
}

export function videoAsset(id = "vid-1", over: Partial<BuilderAsset> = {}): BuilderAsset {
  return {
    creativeId: id,
    type: "VIDEO",
    filename: `${id}.mp4`,
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    load: async () => Buffer.from("fake-mp4-bytes"),
    ...over,
  };
}

export const assetsOf = (...list: BuilderAsset[]) => new Map(list.map((a) => [a.creativeId, a]));

/** The ids of every media field value in a draft, so tests can supply matching assets. */
export function setMedia(draft: BuilderDraft, key: string, ids: string[]) {
  for (const g of draft.adGroups) for (const a of g.ads) a.values[key] = ids;
}
