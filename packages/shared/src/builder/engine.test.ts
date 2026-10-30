import { describe, expect, it } from "vitest";
import {
  defaultValue,
  draftMediaIds,
  emptyContext,
  isBuilderDraft,
  isRequired,
  isVisible,
  issuesAt,
  levelDefaults,
  levelFields,
  listTexts,
  newAd,
  newAdGroup,
  newDraft,
  nodeKey,
  previewValues,
  resolveOptions,
  setupOptions,
  validateDraft,
  visibleDraft,
  visibleValues,
  withDefaults,
  type MediaInfo,
} from "./engine";
import type { BuilderDraft, ChoiceField, Field, FieldContext, LevelSpec, PlatformBuilderSpec, Values } from "./types";

// ───────── A small hand-made spec that exercises every field type ─────────

const campaignLevel: LevelSpec = {
  label: "Campaign",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        { key: "name", type: "text", label: "Name", required: true, maxLength: 10, minLength: 2 },
        { key: "site", type: "url", label: "Site" },
        { key: "mode", type: "segmented", label: "Mode", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
        { key: "count", type: "number", label: "Count", required: true, min: 1, max: 5 },
        { key: "pick", type: "select", label: "Pick", required: true, options: [{ value: "p1", label: "P1" }] },
        { key: "tags", type: "checkboxes", label: "Tags", min: 2, max: 3, options: [{ value: "t1", label: "T1" }, { value: "t2", label: "T2" }] },
        { key: "on", type: "toggle", label: "On", default: true },
        { key: "start", type: "date", label: "Start", required: (ctx) => ctx.campaign.on === false },
        { key: "age", type: "ageRange", label: "Age", min: 18, max: 65 },
        { key: "where", type: "placements", label: "Where", autoLabel: "Auto", autoDescription: "", groups: [{ id: "g", label: "G", items: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] }] },
        { key: "locs", type: "targeting", kind: "location", label: "Locations", required: true, max: 2 },
        { key: "note", type: "info", label: "Note" },
        { key: "sched", type: "adSchedule", label: "Schedule" },
        { key: "acct", type: "accountOption", source: "pages", label: "Page" },
        { key: "accts", type: "accountOption", source: "audiences", label: "Audiences", multiple: true },
        { key: "pct", type: "percent", label: "Pct", default: 10 },
        { key: "onlyA", type: "text", label: "Only A", showIf: (ctx) => ctx.campaign.mode === "A" },
      ],
    },
    {
      id: "bSection",
      title: "B only",
      showIf: (ctx) => ctx.campaign.mode === "B",
      fields: [{ key: "bOnly", type: "text", label: "B only", required: true }],
    },
  ],
};

const adGroupLevel: LevelSpec = {
  label: "Group",
  sections: [
    {
      id: "g",
      title: "Group",
      fields: [
        { key: "name", type: "text", label: "Group name", required: true },
        { key: "keywords", type: "keywords", label: "Keywords", matchTypes: ["BROAD", "EXACT"], min: 2, max: 3, required: true },
        { key: "negatives", type: "keywords", label: "Negatives", matchTypes: ["EXACT"], max: 5, negative: true },
        { key: "kind", type: "radio", label: "Kind", options: (ctx) => (ctx.setup.kind === "X" ? [{ value: "k1", label: "K1" }] : [{ value: "k2", label: "K2" }]), default: (ctx) => (ctx.setup.kind === "X" ? "k1" : "k2") },
        { key: "groupSecret", type: "text", label: "Secret", showIf: (ctx) => ctx.campaign.mode === "B" },
      ],
    },
  ],
};

const adLevel: LevelSpec = {
  label: "Creative",
  sections: [
    {
      id: "ad",
      title: "Ad",
      fields: [
        { key: "name", type: "text", label: "Ad name", required: true },
        { key: "format", type: "cards", label: "Format", options: [{ value: "ONE", label: "One" }, { value: "MANY", label: "Many" }] },
        { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 2, max: 3, maxLength: 5, required: true, pinnable: { positions: ["H1", "H2"] } },
        { key: "extras", type: "textList", label: "Extras", itemLabel: "Extra", min: 0, max: 2, initial: 0, maxLength: 10 },
        { key: "image", type: "media", label: "Image", accept: ["IMAGE"], min: 1, max: 2, required: true, requiredRatio: "1:1", showIf: (ctx) => ctx.ad.format === "ONE" },
        { key: "clip", type: "media", label: "Clip", accept: ["VIDEO"], min: 0, max: 1 },
        { key: "any", type: "media", label: "Any", accept: ["IMAGE", "VIDEO"], min: 0, max: 1 },
        {
          key: "cards",
          type: "repeater",
          label: "Cards",
          itemLabel: "Card",
          min: 2,
          max: 3,
          required: true,
          showIf: (ctx) => ctx.ad.format === "MANY",
          fields: [
            { key: "pic", type: "media", label: "Card pic", accept: ["IMAGE"], min: 1, max: 1, required: true },
            { key: "title", type: "text", label: "Card title", required: true, maxLength: 5 },
          ],
        },
      ],
    },
  ],
};

const spec: PlatformBuilderSpec = {
  platform: "META",
  setup: [
    { key: "kind", label: "Kind", description: "", options: [{ value: "X", label: "X" }, { value: "Y", label: "Y" }] },
    { key: "sub", label: "Sub type", description: "", showIf: (s) => s.kind === "X", options: (s) => (s.kind === "X" ? [{ value: "s1", label: "S1" }] : []) },
  ],
  campaign: campaignLevel,
  adGroup: adGroupLevel,
  ad: (setup) => (setup.kind === "Y" ? null : adLevel),
  maxAdGroups: 2,
  maxAds: 2,
  previews: () => ["fb_feed"],
  validate: (d) => (d.campaign.name === "boom" ? [{ level: "campaign", field: "name", message: "custom" }] : []),
};

const fieldByKey = (level: LevelSpec, key: string) => levelFields(level).find((f) => f.key === key)!;
const ctxOf = (p: Partial<FieldContext> = {}): FieldContext => ({ ...emptyContext(), ...p });

const IMG_SQ: MediaInfo = { type: "IMAGE", width: 1000, height: 1000 };
const IMG_WIDE: MediaInfo = { type: "IMAGE", width: 1910, height: 1000 };
const VID: MediaInfo = { type: "VIDEO", width: 1080, height: 1920 };
const MEDIA = new Map<string, MediaInfo>([
  ["sq1", IMG_SQ],
  ["sq2", IMG_SQ],
  ["sq3", IMG_SQ],
  ["wide", IMG_WIDE],
  ["vid", VID],
  ["nodims", { type: "IMAGE", width: null, height: null }],
]);

/** A draft for the test spec that passes every check. */
function validDraft(): BuilderDraft {
  const d = newDraft(spec, "acc1", { kind: "X", sub: "s1" }, "Camp");
  Object.assign(d.campaign, { count: 3, pick: "p1", locs: [{ id: "IN", name: "India" }] });
  const g = d.adGroups[0]!;
  g.values.keywords = [
    { text: "shoes", matchType: "BROAD" },
    { text: "boots", matchType: "EXACT" },
  ];
  Object.assign(g.ads[0]!.values, { headlines: [{ text: "Hi", pin: null }, { text: "Yo", pin: "H1" }], image: ["sq1"] });
  return d;
}

const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

describe("setupOptions / resolveOptions", () => {
  it("returns static options as they are", () => {
    expect(setupOptions(spec.setup[0]!, {})).toEqual(spec.setup[0]!.options);
    expect(resolveOptions(fieldByKey(campaignLevel, "mode") as ChoiceField, emptyContext()).map((o) => o.value)).toEqual(["A", "B"]);
  });
  it("calls option functions with the setup / context", () => {
    expect(setupOptions(spec.setup[1]!, { kind: "X" }).map((o) => o.value)).toEqual(["s1"]);
    expect(setupOptions(spec.setup[1]!, { kind: "Y" })).toEqual([]);
    const kind = fieldByKey(adGroupLevel, "kind") as ChoiceField;
    expect(resolveOptions(kind, ctxOf({ setup: { kind: "X" } })).map((o) => o.value)).toEqual(["k1"]);
    expect(resolveOptions(kind, ctxOf({ setup: { kind: "Y" } })).map((o) => o.value)).toEqual(["k2"]);
  });
});

describe("isVisible / isRequired", () => {
  it("treats a missing showIf as visible", () => {
    expect(isVisible({}, emptyContext())).toBe(true);
    expect(isVisible({ showIf: () => false }, emptyContext())).toBe(false);
  });
  it("evaluates conditional visibility against the context", () => {
    const onlyA = fieldByKey(campaignLevel, "onlyA");
    expect(isVisible(onlyA, ctxOf({ campaign: { mode: "A" } }))).toBe(true);
    expect(isVisible(onlyA, ctxOf({ campaign: { mode: "B" } }))).toBe(false);
  });
  it("coerces boolean / undefined / function `required`", () => {
    expect(isRequired(fieldByKey(campaignLevel, "name"), emptyContext())).toBe(true);
    expect(isRequired(fieldByKey(campaignLevel, "site"), emptyContext())).toBe(false);
    const start = fieldByKey(campaignLevel, "start");
    expect(isRequired(start, ctxOf({ campaign: { on: false } }))).toBe(true);
    expect(isRequired(start, ctxOf({ campaign: { on: true } }))).toBe(false);
  });
});

describe("listTexts", () => {
  it("reads plain strings and pinned items, trimmed", () => {
    expect(listTexts(["  a ", { text: " b", pin: "H1" }, { pin: "H2" }, null, 5])).toEqual(["a", "b", "", "", ""]);
  });
  it("returns [] for non-arrays", () => {
    expect(listTexts(undefined)).toEqual([]);
    expect(listTexts("abc")).toEqual([]);
    expect(listTexts({ text: "x" })).toEqual([]);
  });
});

describe("defaultValue", () => {
  const ctx = emptyContext();
  const d = (f: Field) => defaultValue(f, ctx);
  it("gives the documented empty values per type", () => {
    expect(d(fieldByKey(campaignLevel, "name"))).toBe("");
    expect(d(fieldByKey(campaignLevel, "count"))).toBeNull();
    expect(d(fieldByKey(campaignLevel, "pct"))).toBe(10);
    expect(d(fieldByKey(campaignLevel, "pick"))).toBe(""); // select without default stays empty
    expect(d(fieldByKey(campaignLevel, "mode"))).toBe("A"); // segmented falls back to the first option
    expect(d(fieldByKey(campaignLevel, "tags"))).toEqual([]);
    expect(d(fieldByKey(campaignLevel, "on"))).toBe(true);
    expect(d(fieldByKey(campaignLevel, "start"))).toBeNull();
    expect(d(fieldByKey(campaignLevel, "acct"))).toBe("");
    expect(d(fieldByKey(campaignLevel, "accts"))).toEqual([]);
    expect(d(fieldByKey(campaignLevel, "locs"))).toEqual([]);
    expect(d(fieldByKey(campaignLevel, "age"))).toEqual({ min: 18, max: 65 });
    expect(d(fieldByKey(campaignLevel, "where"))).toEqual({ mode: "AUTO", items: ["x", "y"] });
    expect(d(fieldByKey(campaignLevel, "sched"))).toEqual({ days: {} });
    expect(d(fieldByKey(campaignLevel, "note"))).toBeUndefined();
    expect(d(fieldByKey(adGroupLevel, "keywords"))).toEqual([]);
    expect(d(fieldByKey(adLevel, "image"))).toEqual([]);
  });
  it("sizes text lists by `initial`, else max(1, min); pinnable lists hold {text,pin}", () => {
    expect(d(fieldByKey(adLevel, "headlines"))).toEqual([{ text: "", pin: null }, { text: "", pin: null }]);
    expect(d(fieldByKey(adLevel, "extras"))).toEqual([]);
    expect(d({ key: "l", type: "textList", label: "L", itemLabel: "I", min: 0, max: 3, maxLength: 5 })).toEqual([""]);
  });
  it("fills a repeater with `min` default items", () => {
    expect(d(fieldByKey(adLevel, "cards"))).toEqual([
      { pic: [], title: "" },
      { pic: [], title: "" },
    ]);
  });
  it("evaluates function defaults with the context", () => {
    expect(defaultValue(fieldByKey(adGroupLevel, "kind"), ctxOf({ setup: { kind: "X" } }))).toBe("k1");
  });
});

describe("levelDefaults / withDefaults", () => {
  it("skips info fields", () => {
    const v = levelDefaults(campaignLevel, emptyContext());
    expect("note" in v).toBe(false);
    expect(v.mode).toBe("A");
  });
  it("adds only missing keys and keeps saved values (even falsy ones)", () => {
    const out = withDefaults(campaignLevel, { name: "Saved", on: false, count: 0 }, emptyContext());
    expect(out.name).toBe("Saved");
    expect(out.on).toBe(false);
    expect(out.count).toBe(0);
    expect(out.mode).toBe("A");
    expect(out.where).toEqual({ mode: "AUTO", items: ["x", "y"] });
    expect("note" in out).toBe(false);
  });
  it("does not mutate the input", () => {
    const input: Values = { name: "x" };
    withDefaults(campaignLevel, input, emptyContext());
    expect(input).toEqual({ name: "x" });
  });
});

describe("newDraft / newAdGroup / newAd", () => {
  it("creates a v2 draft with campaign defaults, one ad group and one ad", () => {
    const d = newDraft(spec, "acc1", { kind: "X" }, "My campaign");
    expect(d).toMatchObject({ version: 2, platform: "META", adAccountId: "acc1", setup: { kind: "X" } });
    expect(d.campaign.name).toBe("My campaign");
    expect(d.campaign.mode).toBe("A");
    expect(d.adGroups).toHaveLength(1);
    expect(d.adGroups[0]!.values.name).toBe("Group 1");
    expect(d.adGroups[0]!.values.kind).toBe("k1");
    expect(d.adGroups[0]!.ads).toHaveLength(1);
    expect(d.adGroups[0]!.ads[0]!.values.name).toBe("Creative 1");
  });
  it("defaults the campaign name to empty", () => {
    expect(newDraft(spec, "a", { kind: "X" }).campaign.name).toBe("");
  });
  it("numbers new ad groups and ads like the platforms", () => {
    const d = newDraft(spec, "a", { kind: "X" });
    const g2 = newAdGroup(spec, d);
    expect(g2.values.name).toBe("Group 2");
    const a2 = newAd(spec, d, d.adGroups[0]!);
    expect(a2!.values.name).toBe("Creative 2");
  });
  it("creates no ads when the setup has no ad level", () => {
    const d = newDraft(spec, "a", { kind: "Y" });
    expect(d.adGroups[0]!.ads).toEqual([]);
    expect(newAd(spec, d, d.adGroups[0]!)).toBeNull();
  });
  it("gives every node a unique, prefixed key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => nodeKey("g")));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^g_/);
    const d = newDraft(spec, "a", { kind: "X" });
    expect(d.adGroups[0]!.key).toMatch(/^g_/);
    expect(d.adGroups[0]!.ads[0]!.key).toMatch(/^a_/);
  });
});

describe("visibleValues", () => {
  it("returns values unchanged for a null level", () => {
    const v = { a: 1 };
    expect(visibleValues(null, v, emptyContext())).toBe(v);
  });
  it("drops hidden fields and fields of hidden sections, keeps unknown keys", () => {
    const values = { name: "n", onlyA: "x", bOnly: "y", extra: 1 };
    expect(visibleValues(campaignLevel, values, ctxOf({ campaign: { mode: "A" } }))).toEqual({ name: "n", onlyA: "x", extra: 1 });
    expect(visibleValues(campaignLevel, values, ctxOf({ campaign: { mode: "B" } }))).toEqual({ name: "n", bOnly: "y", extra: 1 });
  });
  it("keeps a key that one visible field shows even if another field with the same key is hidden", () => {
    const level: LevelSpec = {
      label: "L",
      sections: [
        { id: "a", title: "", fields: [{ key: "k", type: "text", label: "A", showIf: () => false }] },
        { id: "b", title: "", fields: [{ key: "k", type: "text", label: "B" }] },
      ],
    };
    expect(visibleValues(level, { k: "keep" }, emptyContext())).toEqual({ k: "keep" });
  });
});

describe("visibleDraft", () => {
  it("drops hidden values at campaign, ad group and ad level", () => {
    const d = newDraft(spec, "a", { kind: "X" }, "C");
    d.campaign.mode = "A";
    d.campaign.bOnly = "stale";
    d.adGroups[0]!.values.groupSecret = "stale";
    d.adGroups[0]!.ads[0]!.values.format = "ONE";
    d.adGroups[0]!.ads[0]!.values.cards = [{ pic: ["sq1"], title: "x" }];
    const v = visibleDraft(spec, d);
    expect(v.campaign).not.toHaveProperty("bOnly");
    expect(v.adGroups[0]!.values).not.toHaveProperty("groupSecret");
    expect(v.adGroups[0]!.ads[0]!.values).not.toHaveProperty("cards");
    expect(v.adGroups[0]!.ads[0]!.values).toHaveProperty("image");
    // the input draft is untouched
    expect(d.campaign.bOnly).toBe("stale");
  });
  it("uses the campaign values when deciding ad group visibility", () => {
    const d = newDraft(spec, "a", { kind: "X" });
    d.campaign.mode = "B";
    d.adGroups[0]!.values.groupSecret = "keep";
    expect(visibleDraft(spec, d).adGroups[0]!.values.groupSecret).toBe("keep");
  });
  it("switching an ad to the other format drops the first format's values", () => {
    const d = newDraft(spec, "a", { kind: "X" });
    Object.assign(d.adGroups[0]!.ads[0]!.values, { format: "MANY", image: ["sq1"] });
    const ad = visibleDraft(spec, d).adGroups[0]!.ads[0]!.values;
    expect(ad).not.toHaveProperty("image");
    expect(ad).toHaveProperty("cards");
  });
  it("leaves ad values alone when the setup has no ad level", () => {
    const d = newDraft(spec, "a", { kind: "Y" });
    d.adGroups[0]!.ads.push({ key: "a1", values: { anything: 1 } });
    expect(visibleDraft(spec, d).adGroups[0]!.ads[0]!.values).toEqual({ anything: 1 });
  });
});

describe("previewValues", () => {
  it("returns visible values per level", () => {
    const d = newDraft(spec, "a", { kind: "X" });
    d.campaign.mode = "A";
    d.campaign.bOnly = "stale";
    const g = d.adGroups[0]!;
    const a = g.ads[0]!;
    a.values.format = "MANY";
    a.values.image = ["sq1"];
    const p = previewValues(spec, d, g, a);
    expect(p.campaign).not.toHaveProperty("bOnly");
    expect(p.adGroup.name).toBe("Group 1");
    expect(p.ad).not.toHaveProperty("image");
    expect(p.ad.name).toBe("Creative 1");
  });
  it("falls back to the ad group values when there is no ad level", () => {
    const d = newDraft(spec, "a", { kind: "Y" });
    const g = d.adGroups[0]!;
    const p = previewValues(spec, d, g, undefined);
    expect(p.ad).toEqual(p.adGroup);
    expect(p.ad.name).toBe("Group 1");
  });
  it("returns empty objects without a group", () => {
    const d = newDraft(spec, "a", { kind: "X" });
    expect(previewValues(spec, d, undefined, undefined)).toMatchObject({ adGroup: {}, ad: {} });
  });
});

describe("validateDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateDraft(spec, validDraft(), MEDIA)).toEqual([]);
  });

  it("flags missing / unknown setup choices, skipping hidden choices", () => {
    const d = validDraft();
    d.setup = {};
    const setupIssues = issuesAt(validateDraft(spec, d, MEDIA), "setup");
    expect(setupIssues).toEqual([{ level: "setup", field: "kind", message: "Choose kind." }]);
    d.setup = { kind: "X", sub: "nope" };
    expect(issuesAt(validateDraft(spec, d, MEDIA), "setup")).toEqual([{ level: "setup", field: "sub", message: "Choose sub type." }]);
    d.setup = { kind: "Y" };
    expect(issuesAt(validateDraft(spec, d, MEDIA), "setup")).toEqual([]);
  });

  describe("text fields", () => {
    const check = (patch: Values) => {
      const d = validDraft();
      Object.assign(d.campaign, patch);
      return validateDraft(spec, d, MEDIA).filter((i) => i.level === "campaign");
    };
    it("required, after trimming", () => {
      expect(messages(check({ name: "   " }))).toEqual(["Name is required."]);
      expect(messages(check({ name: 42 }))).toEqual(["Name is required."]);
    });
    it("max and min length", () => {
      expect(messages(check({ name: "abcdefghijk" }))).toEqual(["Name is over 10 characters."]);
      expect(messages(check({ name: "  abcdefghij  " }))).toEqual([]);
      expect(messages(check({ name: "a" }))).toEqual(["Name needs at least 2 characters."]);
    });
    it("optional URL fields are checked only when filled", () => {
      expect(check({ site: "" })).toEqual([]);
      expect(messages(check({ site: "yourstore.com" }))).toEqual(["Site must be a full URL starting with https://"]);
      expect(messages(check({ site: "ftp://yourstore.com" }))).toEqual(["Site must be a full URL starting with https://"]);
      expect(check({ site: "https://yourstore.com/sale?x=1" })).toEqual([]);
      expect(check({ site: "http://www.example.co.in" })).toEqual([]);
    });
    it("accepts a one-letter domain such as https://x.com", () => {
      expect(check({ site: "https://x.com" })).toEqual([]);
      expect(check({ site: "https://t.co/abc" })).toEqual([]);
      expect(messages(check({ site: "https://x" }))).toEqual(["Site must be a full URL starting with https://"]);
      expect(messages(check({ site: "https://.com" }))).toEqual(["Site must be a full URL starting with https://"]);
    });
    it("tags the issue with level and field", () => {
      expect(check({ name: "" })[0]).toEqual({ level: "campaign", field: "name", message: "Name is required." });
    });
  });

  describe("number fields", () => {
    const check = (count: unknown) => {
      const d = validDraft();
      d.campaign.count = count;
      return messages(validateDraft(spec, d, MEDIA));
    };
    it("required: null, empty string and NaN count as empty", () => {
      expect(check(null)).toEqual(["Count is required."]);
      expect(check("")).toEqual(["Count is required."]);
      expect(check("abc")).toEqual(["Count is required."]);
    });
    it("bounds, including numeric strings", () => {
      expect(check(0)).toEqual(["Count must be at least 1."]);
      expect(check(6)).toEqual(["Count must be at most 5."]);
      expect(check("4")).toEqual([]);
      expect(check(1)).toEqual([]);
      expect(check(5)).toEqual([]);
    });
    it("optional numbers may be empty", () => {
      const d = validDraft();
      d.campaign.pct = null;
      expect(validateDraft(spec, d, MEDIA)).toEqual([]);
    });
  });

  it("choice, date and account fields only check presence", () => {
    const d = validDraft();
    d.campaign.pick = "";
    d.campaign.on = false;
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Pick is required.", "Start is required."]);
    d.campaign.start = "2026-11-01";
    d.campaign.pick = "p1";
    expect(validateDraft(spec, d, MEDIA)).toEqual([]);
  });

  it("multi-choice min/max (min only once something is chosen)", () => {
    const d = validDraft();
    d.campaign.tags = ["t1"];
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Choose at least 2 for tags."]);
    d.campaign.tags = ["t1", "t2", "t3", "t4"];
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Choose at most 3 for tags."]);
    d.campaign.tags = [];
    expect(validateDraft(spec, d, MEDIA)).toEqual([]);
  });

  it("required multi-choice needs one", () => {
    const level: LevelSpec = { label: "L", sections: [{ id: "s", title: "", fields: [{ key: "m", type: "chips", label: "Topics", required: true, options: [] }] }] };
    const s2: PlatformBuilderSpec = { ...spec, setup: [], campaign: level };
    const d = newDraft(s2, "a", { kind: "Y" });
    d.adGroups = [];
    expect(messages(validateDraft(s2, d, MEDIA))).toContain("Choose at least one topics.");
  });

  it("targeting: excluded entries don't count as included, max counts all", () => {
    const d = validDraft();
    d.campaign.locs = [{ id: "US", name: "US", exclude: true }];
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Add at least one locations."]);
    d.campaign.locs = [{ id: "IN", name: "IN" }, { id: "US", name: "US", exclude: true }, { id: "GB", name: "GB" }];
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Use at most 2 locations."]);
    d.campaign.locs = "garbage";
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Add at least one locations."]);
  });

  it("age range min must not exceed max", () => {
    const d = validDraft();
    d.campaign.age = { min: 40, max: 30 };
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Minimum age must be below the maximum age."]);
    d.campaign.age = { min: 30, max: 30 };
    expect(validateDraft(spec, d, MEDIA)).toEqual([]);
  });

  it("manual placements need at least one item", () => {
    const d = validDraft();
    d.campaign.where = { mode: "MANUAL", items: [] };
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Choose at least one placement, or switch to automatic placements."]);
    d.campaign.where = { mode: "AUTO", items: [] };
    expect(validateDraft(spec, d, MEDIA)).toEqual([]);
  });

  it("hidden sections and fields are not validated", () => {
    const d = validDraft();
    d.campaign.mode = "B";
    expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["B only is required."]);
    d.campaign.bOnly = "ok";
    expect(validateDraft(spec, d, MEDIA)).toEqual([]);
  });

  describe("keywords", () => {
    const check = (keywords: unknown, negatives?: unknown) => {
      const d = validDraft();
      d.adGroups[0]!.values.keywords = keywords;
      if (negatives !== undefined) d.adGroups[0]!.values.negatives = negatives;
      return validateDraft(spec, d, MEDIA);
    };
    const kw = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `kw ${i}`, matchType: "BROAD" }));
    it("min, max, and length per keyword", () => {
      expect(messages(check(kw(1)))).toEqual(["Add at least 2 keywords."]);
      expect(messages(check([]))).toEqual(["Add at least 2 keywords."]);
      expect(messages(check(kw(4)))).toEqual(["Use at most 3 keywords."]);
      expect(messages(check([{ text: "x".repeat(81), matchType: "EXACT" }, ...kw(1)]))).toEqual(["Keyword “xxxxxxxxxxxxxxxxxxxx…” is too long (80 characters max)."]);
      expect(check([{ text: "x".repeat(80), matchType: "EXACT" }, ...kw(1)])).toEqual([]);
    });
    it("tags keyword issues with the ad group node key", () => {
      const d = validDraft();
      d.adGroups[0]!.values.keywords = [];
      const [issue] = validateDraft(spec, d, MEDIA);
      expect(issue).toMatchObject({ level: "adGroup", nodeKey: d.adGroups[0]!.key, field: "keywords" });
    });
    it("optional negative keywords: only the max applies", () => {
      expect(check(kw(2), [])).toEqual([]);
      expect(messages(check(kw(2), kw(6)))).toEqual(["Use at most 5 keywords."]);
    });
    it("a required keyword field without min needs one", () => {
      const level: LevelSpec = { label: "G", sections: [{ id: "s", title: "", fields: [{ key: "neg", type: "keywords", label: "Neg", matchTypes: ["EXACT"], max: 5, required: true, negative: true }] }] };
      const s2 = { ...spec, adGroup: level, ad: () => null };
      const d = newDraft(s2, "a", { kind: "Y" });
      Object.assign(d.campaign, validDraft().campaign);
      expect(messages(validateDraft(s2, d, MEDIA))).toEqual(["Add at least one negative keyword."]);
    });
  });

  describe("text lists", () => {
    const check = (headlines: unknown, extras?: unknown) => {
      const d = validDraft();
      d.adGroups[0]!.ads[0]!.values.headlines = headlines;
      if (extras !== undefined) d.adGroups[0]!.ads[0]!.values.extras = extras;
      return messages(validateDraft(spec, d, MEDIA));
    };
    it("counts non-empty items, plain or pinned", () => {
      expect(check(["One", { text: "", pin: null }])).toEqual(["Add at least 2 headlines."]);
      expect(check(["One", { text: "Two", pin: "H2" }])).toEqual([]);
      expect(check(["a", "b", "c", "d"])).toEqual(["Use at most 3 headlines."]);
    });
    it("checks each item's length and duplicates (case-insensitive)", () => {
      expect(check(["abcdef", "ok"])).toEqual(["Headline 1 is over 5 characters."]);
      expect(check(["Same", "same"])).toEqual(["Headlines must be different from each other."]);
    });
    it("optional lists with min 0 can be empty", () => {
      expect(check(["a", "b"], [])).toEqual([]);
      expect(check(["a", "b"], ["x", "y", "z"])).toEqual(["Use at most 2 extras."]);
    });
    it("uses singular wording when min is 1", () => {
      const level: LevelSpec = { label: "A", sections: [{ id: "s", title: "", fields: [{ key: "t", type: "textList", label: "T", itemLabel: "Primary text", min: 1, max: 2, maxLength: 9 }] }] };
      const s2 = { ...spec, ad: () => level };
      const d = validDraft();
      d.adGroups[0]!.ads[0]!.values = { t: [""] };
      expect(messages(validateDraft(s2, d, MEDIA))).toEqual(["Add at least one primary text."]);
    });
  });

  describe("media", () => {
    const check = (patch: Values) => {
      const d = validDraft();
      Object.assign(d.adGroups[0]!.ads[0]!.values, patch);
      return messages(validateDraft(spec, d, MEDIA));
    };
    it("required media needs a known file (unknown ids don't count)", () => {
      expect(check({ image: [] })).toEqual(["Image: add an image."]);
      expect(check({ image: ["missing"] })).toEqual(["Image: add an image."]);
      expect(check({ image: "sq1" })).toEqual(["Image: add an image."]);
    });
    it("max, type and required ratio", () => {
      expect(check({ image: ["sq1", "sq2", "sq3"] })).toEqual(["Use at most 2 files for image."]);
      expect(check({ image: ["vid"] })).toEqual(["Image only accepts images.", "Image must be 1:1."]);
      expect(check({ image: ["wide"] })).toEqual(["Image must be 1:1."]);
      expect(check({ clip: ["sq1"] })).toEqual(["Clip only accepts videos."]);
      expect(check({ any: ["vid"] })).toEqual([]);
    });
    it("allows ±0.03 ratio tolerance and skips files without dimensions", () => {
      const media = new Map(MEDIA);
      media.set("almost", { type: "IMAGE", width: 1020, height: 1000 });
      media.set("off", { type: "IMAGE", width: 1040, height: 1000 });
      const d = validDraft();
      d.adGroups[0]!.ads[0]!.values.image = ["almost", "nodims"];
      expect(validateDraft(spec, d, media)).toEqual([]);
      d.adGroups[0]!.ads[0]!.values.image = ["off"];
      expect(messages(validateDraft(spec, d, media))).toEqual(["Image must be 1:1."]);
    });
    it("uses 'an image or video' / 'at least N files' wording", () => {
      const level: LevelSpec = {
        label: "A",
        sections: [
          {
            id: "s",
            title: "",
            fields: [
              { key: "both", type: "media", label: "Both", accept: ["IMAGE", "VIDEO"], min: 1, max: 1, required: true },
              { key: "vids", type: "media", label: "Vids", accept: ["VIDEO"], min: 1, max: 1, required: true },
              { key: "many", type: "media", label: "Many", accept: ["IMAGE"], min: 3, max: 5 },
            ],
          },
        ],
      };
      const s2 = { ...spec, ad: () => level };
      const d = validDraft();
      d.adGroups[0]!.ads[0]!.values = { many: ["sq1"] };
      expect(messages(validateDraft(s2, d, MEDIA))).toEqual(["Both: add an image or video.", "Vids: add a video.", "Many: add at least 3 files."]);
    });
  });

  describe("repeater", () => {
    const check = (cards: unknown) => {
      const d = validDraft();
      Object.assign(d.adGroups[0]!.ads[0]!.values, { format: "MANY", cards });
      return messages(validateDraft(spec, d, MEDIA));
    };
    const card = (title: string, pic = ["sq1"]) => ({ pic, title });
    it("counts only filled items toward min/max", () => {
      expect(check([card("A"), { pic: [], title: "" }])).toEqual(["Add at least 2 cards."]);
      expect(check([card("A"), card("B")])).toEqual([]);
      expect(check([card("A"), card("B"), card("C"), card("D")])).toEqual(["Use at most 3 cards."]);
      expect(check("nope")).toEqual(["Add at least 2 cards."]);
    });
    it("validates sub-fields of each filled item with an item prefix", () => {
      expect(check([card("A"), card("toolong", [])])).toEqual(["Card 2: Card pic: add an image.", "Card 2: Card title is over 5 characters."]);
    });
  });

  describe("ad group / ad counts", () => {
    it("needs at least one ad group and respects maxAdGroups", () => {
      const d = validDraft();
      d.adGroups = [];
      expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Add at least one group."]);
      const full = validDraft();
      const extra = () => structuredClone(full.adGroups[0]!);
      full.adGroups.push(extra());
      expect(validateDraft(spec, full, MEDIA)).toEqual([]);
      full.adGroups.push(extra());
      expect(messages(validateDraft(spec, full, MEDIA))).toEqual(["Use at most 2 groups."]);
    });
    it("needs at least one ad per group and respects maxAds", () => {
      const d = validDraft();
      const g = d.adGroups[0]!;
      const ad = g.ads[0]!;
      g.ads = [];
      expect(validateDraft(spec, d, MEDIA)).toEqual([{ level: "adGroup", nodeKey: g.key, message: "Add at least one creative." }]);
      g.ads = [ad, structuredClone(ad)];
      expect(validateDraft(spec, d, MEDIA)).toEqual([]);
      g.ads.push(structuredClone(ad));
      expect(messages(validateDraft(spec, d, MEDIA))).toEqual(["Use at most 2 creatives per group."]);
    });
    it("ignores ads when the setup has no ad level", () => {
      const d = validDraft();
      d.setup = { kind: "Y" };
      d.adGroups[0]!.ads = [];
      expect(validateDraft(spec, d, MEDIA)).toEqual([]);
    });
  });

  it("appends the spec's own cross-field checks", () => {
    const d = validDraft();
    d.campaign.name = "boom";
    expect(validateDraft(spec, d, MEDIA)).toEqual([{ level: "campaign", field: "name", message: "custom" }]);
  });

  it("issuesAt filters by level and node", () => {
    const d = validDraft();
    d.campaign.name = "";
    d.adGroups[0]!.values.name = "";
    d.adGroups[0]!.ads[0]!.values.name = "";
    const issues = validateDraft(spec, d, MEDIA);
    expect(issuesAt(issues, "campaign")).toHaveLength(1);
    expect(issuesAt(issues, "adGroup", d.adGroups[0]!.key)).toHaveLength(1);
    expect(issuesAt(issues, "adGroup", "other")).toHaveLength(0);
    expect(issuesAt(issues, "ad")).toHaveLength(1);
  });
});

describe("isBuilderDraft", () => {
  it("accepts v2 drafts only", () => {
    expect(isBuilderDraft(newDraft(spec, "a", { kind: "X" }))).toBe(true);
    expect(isBuilderDraft({ version: 2, platform: "META", adGroups: [] })).toBe(true);
    expect(isBuilderDraft({ version: 1, platform: "META", adGroups: [] })).toBe(false);
    expect(isBuilderDraft({ version: 2, platform: 3, adGroups: [] })).toBe(false);
    expect(isBuilderDraft({ version: 2, platform: "META", adGroups: {} })).toBe(false);
    expect(isBuilderDraft(null)).toBe(false);
    expect(isBuilderDraft(undefined)).toBe(false);
    expect(isBuilderDraft("draft")).toBe(false);
  });
});

describe("draftMediaIds", () => {
  it("collects unique ids from media fields at every level, including repeaters", () => {
    const withCampaignMedia: PlatformBuilderSpec = {
      ...spec,
      campaign: { label: "C", sections: [{ id: "s", title: "", fields: [{ key: "logo", type: "media", label: "Logo", accept: ["IMAGE"], min: 0, max: 1 }] }] },
    };
    const d = newDraft(withCampaignMedia, "a", { kind: "X" });
    d.campaign.logo = ["logo1"];
    const g = d.adGroups[0]!;
    g.ads[0]!.values.image = ["img1", "img2"];
    g.ads[0]!.values.cards = [{ pic: ["c1"] }, { pic: ["c2", "img1"] }, null];
    g.ads.push({ key: "a2", values: { clip: ["v1"], any: "not-an-array" } });
    expect(draftMediaIds(withCampaignMedia, d).sort()).toEqual(["c1", "c2", "img1", "img2", "logo1", "v1"]);
  });
  it("ignores ads when the setup has no ad level", () => {
    const d = newDraft(spec, "a", { kind: "Y" });
    d.adGroups[0]!.ads.push({ key: "a", values: { image: ["x"] } });
    expect(draftMediaIds(spec, d)).toEqual([]);
  });
});
