/**
 * Generic, table-driven invariants every platform spec must keep.
 * Per-platform rules live in specs.platforms.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLATFORMS, VISIBLE_PLATFORMS, isPlatformShown, type Platform } from "../platforms";
import { BUILDER_SPECS, builderSpec } from "./index";
import { isRequired, isVisible, levelFields, newAd, newAdGroup, newDraft, resolveOptions, setupOptions, validateDraft, visibleDraft } from "./engine";
import type { BuilderDraft, Field, FieldContext, LevelSpec, PlatformBuilderSpec, Values } from "./types";

/** Every id in the PlacementPreview union, read from types.ts so a new id needs no test change. */
const PREVIEW_IDS = (() => {
  const src = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
  const block = /export type PlacementPreview\s*=([^;]+);/.exec(src)?.[1] ?? "";
  return new Set([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
})();

/** Every combination of start-screen choices (including disabled options). */
function setupCombos(spec: PlatformBuilderSpec): Values[] {
  let combos: Values[] = [{}];
  for (const choice of spec.setup) {
    const next: Values[] = [];
    for (const s of combos) {
      if (choice.showIf && !choice.showIf(s)) {
        next.push(s);
        continue;
      }
      for (const o of setupOptions(choice, s)) next.push({ ...s, [choice.key]: o.value });
    }
    combos = next;
  }
  return combos;
}

const enabledCombo = (spec: PlatformBuilderSpec, setup: Values) =>
  spec.setup.every((c) => (c.showIf && !c.showIf(setup)) || setupOptions(c, setup).find((o) => o.value === setup[c.key])?.disabled !== true);

const comboName = (setup: Values) => Object.values(setup).join("/") || "(none)";

const CASES = (Object.keys(BUILDER_SPECS) as Platform[]).flatMap((platform) =>
  setupCombos(BUILDER_SPECS[platform]).map((setup) => ({ platform, setup, name: `${platform} ${comboName(setup)}` })),
);

const draftOf = (platform: Platform, setup: Values) => newDraft(BUILDER_SPECS[platform], "acc", setup, "Test campaign");

/** The [level, values, ctx] triples of a draft, as the form would evaluate them. */
function levelsOf(spec: PlatformBuilderSpec, d: BuilderDraft) {
  const out: { where: "campaign" | "adGroup" | "ad"; level: LevelSpec; values: Values; ctx: FieldContext }[] = [];
  const base: FieldContext = { setup: d.setup, campaign: d.campaign, adGroup: {}, ad: {} };
  out.push({ where: "campaign", level: spec.campaign, values: d.campaign, ctx: base });
  const adSpec = spec.ad(d.setup);
  for (const g of d.adGroups) {
    const gctx = { ...base, adGroup: g.values };
    out.push({ where: "adGroup", level: spec.adGroup, values: g.values, ctx: gctx });
    if (adSpec) for (const a of g.ads) out.push({ where: "ad", level: adSpec, values: a.values, ctx: { ...gctx, ad: a.values } });
  }
  return out;
}

const allFields = (fields: Field[]): Field[] => fields.flatMap((f) => (f.type === "repeater" ? [f, ...allFields(f.fields)] : [f]));
const hasOptions = (f: Field): f is Extract<Field, { options: unknown }> => "options" in f;

describe("BUILDER_SPECS registry", () => {
  it("has a spec for every platform, keyed by its own platform", () => {
    expect(Object.keys(BUILDER_SPECS).sort()).toEqual([...PLATFORMS].sort());
    for (const p of PLATFORMS) {
      expect(BUILDER_SPECS[p].platform).toBe(p);
      expect(builderSpec(p)).toBe(BUILDER_SPECS[p]);
    }
  });
  it("covers every visible platform with at least one enabled setup", () => {
    for (const p of VISIBLE_PLATFORMS) expect(CASES.some((c) => c.platform === p && enabledCombo(BUILDER_SPECS[p], c.setup))).toBe(true);
  });
  it("reads a non-empty PlacementPreview union from types.ts", () => {
    expect(PREVIEW_IDS.size).toBeGreaterThan(20);
    expect(PREVIEW_IDS.has("fb_feed")).toBe(true);
  });
});

describe.each(CASES)("$name", ({ platform, setup }) => {
  const spec = BUILDER_SPECS[platform];

  it("builds a draft, visible draft and validation without throwing", () => {
    const d = draftOf(platform, setup);
    expect(d.platform).toBe(platform);
    expect(d.adGroups).toHaveLength(1);
    expect(d.adGroups[0]!.ads).toHaveLength(spec.ad(setup) ? 1 : 0);
    expect(d.campaign.name).toBe("Test campaign");
    expect(d.adGroups[0]!.values.name).toBe(`${spec.adGroup.label} 1`);
    const adSpec = spec.ad(setup);
    if (adSpec) expect(d.adGroups[0]!.ads[0]!.values.name).toBe(`${adSpec.label} 1`);
    expect(() => visibleDraft(spec, d)).not.toThrow();
    const issues = validateDraft(spec, d, new Map());
    expect(Array.isArray(issues)).toBe(true);
    for (const i of issues) {
      expect(["setup", "campaign", "adGroup", "ad"]).toContain(i.level);
      expect(i.message.length).toBeGreaterThan(0);
    }
    // A complete start screen never yields a setup issue from the generic check (disabled options aside).
    if (enabledCombo(spec, setup)) expect(issues.filter((i) => i.level === "setup" && !i.message.includes("API"))).toEqual([]);
  });

  it("every showIf / required / options / default function runs on the default draft", () => {
    const d = draftOf(platform, setup);
    for (const { level, ctx } of levelsOf(spec, d)) {
      for (const section of level.sections) {
        expect(typeof isVisible(section, ctx)).toBe("boolean");
        for (const f of allFields(section.fields)) {
          expect(typeof isVisible(f, ctx)).toBe("boolean");
          expect(typeof isRequired(f, ctx)).toBe("boolean");
          if (hasOptions(f)) expect(Array.isArray(resolveOptions(f, ctx))).toBe(true);
          if ("default" in f && typeof f.default === "function") expect(typeof f.default(ctx)).toBe("string");
        }
      }
    }
  });

  it("every visible choice field's value is one of its options", () => {
    const d = draftOf(platform, setup);
    const bad: string[] = [];
    for (const { where, level, values, ctx } of levelsOf(spec, d)) {
      for (const section of level.sections) {
        if (!isVisible(section, ctx)) continue;
        for (const f of section.fields) {
          if (!hasOptions(f) || !isVisible(f, ctx)) continue;
          const allowed = resolveOptions(f, ctx).map((o) => o.value);
          const v = values[f.key];
          const picked = Array.isArray(v) ? v : v === "" || v == null ? [] : [v];
          for (const p of picked) if (!allowed.includes(String(p))) bad.push(`${where}.${f.key}=${String(p)}`);
        }
      }
    }
    if (platform === "META" && setup.objective === "OUTCOME_ENGAGEMENT") return; // known bug, see specs.platforms.test.ts
    expect(bad).toEqual([]);
  });

  it("previews() returns known PlacementPreview ids", () => {
    const d = draftOf(platform, setup);
    for (const { where, ctx } of levelsOf(spec, d)) {
      if (where === "campaign") continue;
      const ids = spec.previews(ctx);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(PREVIEW_IDS).toContain(id);
    }
  });

  it("apiCreatable is absent, true or a message", () => {
    if (!spec.apiCreatable) return;
    const r = spec.apiCreatable(setup);
    expect(r === true || (typeof r === "string" && r.length > 10)).toBe(true);
  });

  it("validateDraft enforces maxAdGroups and maxAds exactly", () => {
    const d = draftOf(platform, setup);
    const countIssue = (msgs: string[]) => msgs.filter((m) => m.startsWith("Use at most"));
    while (d.adGroups.length < spec.maxAdGroups) d.adGroups.push(newAdGroup(spec, d));
    const adSpec = spec.ad(setup);
    if (adSpec) {
      const g = d.adGroups[0]!;
      while (g.ads.length < spec.maxAds) g.ads.push(newAd(spec, d, g)!);
    }
    const atMax = validateDraft(spec, d, new Map()).filter((i) => !i.field);
    expect(countIssue(atMax.map((i) => i.message))).toEqual([]);

    d.adGroups.push(newAdGroup(spec, d));
    const overGroups = validateDraft(spec, d, new Map()).filter((i) => !i.field);
    expect(overGroups).toContainEqual({ level: "campaign", message: `Use at most ${spec.maxAdGroups} ${spec.adGroup.label.toLowerCase()}s.` });

    if (adSpec) {
      const g = d.adGroups[0]!;
      g.ads.push(newAd(spec, d, g)!);
      const overAds = validateDraft(spec, d, new Map());
      expect(overAds).toContainEqual({
        level: "adGroup",
        nodeKey: g.key,
        message: `Use at most ${spec.maxAds} ${adSpec.label.toLowerCase()}s per ${spec.adGroup.label.toLowerCase()}.`,
      });
    }
  });
});

describe.each(PLATFORMS.map((p) => ({ platform: p })))("$platform field definitions", ({ platform }) => {
  const spec = BUILDER_SPECS[platform];
  const levels = (setup: Values) => [spec.campaign, spec.adGroup, spec.ad(setup)].filter((l): l is LevelSpec => Boolean(l));
  const fieldsOf = () => setupCombos(spec).flatMap((s) => levels(s).flatMap((l) => allFields(levelFields(l))));

  it("has sane limits on every field", () => {
    for (const f of fieldsOf()) {
      const where = `${f.key} (${f.label})`;
      expect(f.key, where).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      if ("maxLength" in f && f.maxLength != null && "recommendedLength" in f && f.recommendedLength != null) expect(f.recommendedLength, where).toBeLessThanOrEqual(f.maxLength);
      if (f.type === "textList") {
        expect(f.min, where).toBeLessThanOrEqual(f.max);
        expect(f.initial ?? Math.max(1, f.min), where).toBeLessThanOrEqual(f.max);
      }
      if (f.type === "media") {
        expect(f.min, where).toBeLessThanOrEqual(f.max);
        if (f.requiredRatio) expect(f.ratios ?? [], where).toContain(f.requiredRatio);
      }
      if (f.type === "repeater") expect(f.min, where).toBeLessThanOrEqual(f.max);
      if ((f.type === "number" || f.type === "money" || f.type === "percent") && f.min != null && f.max != null) expect(f.min, where).toBeLessThanOrEqual(f.max);
      if ((f.type === "number" || f.type === "money" || f.type === "percent") && f.default != null) {
        if (f.min != null) expect(f.default, where).toBeGreaterThanOrEqual(f.min);
        if (f.max != null) expect(f.default, where).toBeLessThanOrEqual(f.max);
      }
      if (f.type === "ageRange" && f.default) {
        expect(f.default.min, where).toBeGreaterThanOrEqual(f.min);
        expect(f.default.max, where).toBeLessThanOrEqual(f.max);
      }
    }
  });

  it("static defaults are among the field's static options", () => {
    for (const f of fieldsOf()) {
      if (!hasOptions(f) || typeof f.options === "function" || f.default == null || typeof f.default === "function") continue;
      const allowed = f.options.map((o) => o.value);
      for (const v of Array.isArray(f.default) ? f.default : [f.default]) expect(allowed, `${f.key}`).toContain(v);
    }
  });

  it("option values are unique per field", () => {
    for (const f of fieldsOf()) {
      if (!hasOptions(f) || typeof f.options === "function") continue;
      const values = f.options.map((o) => o.value);
      expect(new Set(values).size, f.key).toBe(values.length);
    }
  });

  it("conditions only read keys that exist in the spec", () => {
    // Trace which keys every condition reads, through Proxies over the default draft.
    const setupKeys = new Set(spec.setup.map((c) => c.key));
    const keysAt = { campaign: new Set<string>(), adGroup: new Set<string>(), ad: new Set<string>() };
    const read = { setup: new Set<string>(), campaign: new Set<string>(), adGroup: new Set<string>(), ad: new Set<string>() };
    const combos = setupCombos(spec);
    for (const s of combos) {
      for (const f of levelFields(spec.campaign)) keysAt.campaign.add(f.key);
      for (const f of levelFields(spec.adGroup)) keysAt.adGroup.add(f.key);
      const ad = spec.ad(s);
      if (ad) for (const f of allFields(levelFields(ad))) keysAt.ad.add(f.key);
    }
    const spy = (which: keyof typeof read, obj: Values) =>
      new Proxy(obj, {
        get(target, prop) {
          if (typeof prop === "string") read[which].add(prop);
          return target[prop as string];
        },
      });
    for (const s of combos) {
      const d = draftOf(platform, s);
      for (const { level, ctx } of levelsOf(spec, d)) {
        const traced: FieldContext = { setup: spy("setup", ctx.setup), campaign: spy("campaign", ctx.campaign), adGroup: spy("adGroup", ctx.adGroup), ad: spy("ad", ctx.ad) };
        for (const section of level.sections) {
          isVisible(section, traced);
          for (const f of allFields(section.fields)) {
            isVisible(f, traced);
            isRequired(f, traced);
            if (hasOptions(f)) resolveOptions(f, traced);
            if ("default" in f && typeof f.default === "function") f.default(traced);
          }
        }
        spec.previews(traced);
      }
      for (const c of spec.setup) {
        c.showIf?.(spy("setup", s));
        setupOptions(c, spy("setup", s));
      }
    }
    // The tracing itself works: Meta's conditions read the conversion location and the objective.
    if (platform === "META") expect([read.adGroup.has("conversionLocation"), read.setup.has("objective")]).toEqual([true, true]);
    for (const k of read.setup) expect(setupKeys, `setup.${k}`).toContain(k);
    for (const where of ["campaign", "adGroup", "ad"] as const) {
      for (const k of read[where]) {
        // `lifetimeNeedsEnd` deliberately checks both campaign and ad group budget types.
        if (k === "budgetType" && (keysAt.campaign.has(k) || keysAt.adGroup.has(k))) continue;
        expect(keysAt[where], `${where}.${k}`).toContain(k);
      }
    }
  });
});

describe("hidden platforms", () => {
  const hidden = PLATFORMS.filter((p) => !isPlatformShown(p));
  it("are TikTok, Swiggy, Zepto and Naukri", () => {
    expect(hidden).toEqual(["TIKTOK", "SWIGGY", "ZEPTO", "NAUKRI"]);
  });
  it.each(["SWIGGY", "ZEPTO", "NAUKRI"] as const)("%s says it can't be published through an API", (p) => {
    for (const setup of setupCombos(BUILDER_SPECS[p])) {
      const r = BUILDER_SPECS[p].apiCreatable!(setup);
      expect(typeof r).toBe("string");
      expect(r).toMatch(/no public ads API/);
    }
  });
  it("TikTok keeps a full spec but declares no apiCreatable (the launch path blocks it as not shown)", () => {
    expect(BUILDER_SPECS.TIKTOK.apiCreatable).toBeUndefined();
    expect(isPlatformShown("TIKTOK")).toBe(false);
  });
});
