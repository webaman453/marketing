/**
 * Contract-test harness: fills a builder draft from the platform's form spec,
 * runs the connector's createCampaign against a recording fetch mock, and
 * records which draft keys the connector read (via Proxies on the values).
 *
 * Nothing here leaves the machine: every fetch is answered by the platform's
 * `respond` function.
 */
import { vi } from "vitest";
import {
  isRequired,
  isVisible,
  levelFields,
  newDraft,
  resolveOptions,
  setupOptions,
  validateDraft,
  visibleDraft,
  type BuilderDraft,
  type BuilderIssue,
  type Field,
  type FieldContext,
  type LevelSpec,
  type MediaInfo,
  type PlatformBuilderSpec,
  type Values,
} from "@ashniva/shared";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth } from "../../src/types";

// ───────── Recording fetch ─────────

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Parsed JSON / form body, a multipart summary, or a binary marker. */
  body: unknown;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** A string is sent as-is (CSV, form-encoded text); anything else as JSON. */
  body: unknown;
}

export type Responder = (req: Recorded, all: Recorded[]) => unknown;

/** Marks a responder result that needs a status or headers. */
export const reply = (body: unknown, headers: Record<string, string> = {}, status = 200): Reply & { __reply: true } => ({ __reply: true, body, headers, status });

function parseBody(raw: unknown, contentType: string): unknown {
  if (raw == null) return undefined;
  if (typeof FormData !== "undefined" && raw instanceof FormData) {
    const out: Record<string, string> = {};
    for (const [k, v] of (raw as unknown as Iterable<[string, FormDataEntryValue]>)) out[k] = typeof v === "string" ? (k === "access_token" ? "<token>" : v) : `<file ${(v as File).name ?? "blob"} ${(v as File).type ?? ""}>`;
    return { multipart: out };
  }
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer || (typeof Blob !== "undefined" && raw instanceof Blob)) return "<binary>";
  if (typeof raw !== "string") return "<stream>";
  const s = raw;
  if (/^\s*[[{]/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  if (contentType.includes("x-www-form-urlencoded") || /^[\w%.-]+=/.test(s)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(s)) {
      // Meta sends nested objects as JSON strings inside the form.
      let value: unknown = v;
      if (/^\s*[[{]/.test(v)) {
        try {
          value = JSON.parse(v);
        } catch {
          value = v;
        }
      }
      out[k] = value;
    }
    return out;
  }
  return s;
}

/** Installs a fetch spy that records every request and answers with `respond`. */
export function recordFetch(respond: Responder) {
  const calls: Recorded[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
    else for (const [k, v] of Object.entries((h ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const rec: Recorded = { method, url, headers, body: parseBody(init?.body, headers["content-type"] ?? "") };
    calls.push(rec);
    const out = respond(rec, calls);
    const r: Reply = out && typeof out === "object" && (out as { __reply?: boolean }).__reply ? (out as Reply) : { body: out };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": typeof r.body === "string" ? "text/plain" : "application/json", ...r.headers } });
  });
  return { calls, restore: () => spy.mockRestore() };
}

// ───────── Setup combinations ─────────

/** Every setup the start screen allows (disabled options and non-API setups dropped), capped. */
export function setupCombos(spec: PlatformBuilderSpec, cap = 40): Values[] {
  let acc: Values[] = [{}];
  for (const choice of spec.setup) {
    const next: Values[] = [];
    for (const s of acc) {
      if (choice.showIf && !choice.showIf(s)) {
        next.push(s);
        continue;
      }
      for (const o of setupOptions(choice, s)) if (!o.disabled) next.push({ ...s, [choice.key]: o.value });
    }
    acc = next;
  }
  const ok = acc.filter((s) => (spec.apiCreatable ? spec.apiCreatable(s) === true : true));
  if (ok.length <= cap) return ok;
  const step = ok.length / cap;
  return Array.from({ length: cap }, (_, i) => ok[Math.floor(i * step)]!);
}

export const setupLabel = (s: Values) => Object.values(s).join(" / ") || "default";

// ───────── Sample values ─────────

export interface Samples {
  /** Platform overrides by field key (text/url/accountOption values). */
  text?: Record<string, string>;
  accountOption?: Record<string, string>;
}

const GLOBAL_TEXT: Record<string, string> = {
  adamId: "1234567890",
  asin: "B0TESTASIN",
  asins: "B0TESTASIN\nB0TESTASI2",
  sku: "SKU-RED-M",
  fundingInstrumentId: "fi-contract",
  productPageId: "45812c9b-c296-43d3-c6a0-c5a02f74bf6e",
  phone: "+919876543210",
  urlParams: "utm_source=contract&utm_medium=paid",
  trackingTemplate: "{lpurl}?src=contract",
  finalUrlSuffix: "src=contract",
  displayLink: "example.com",
  path1: "sale",
  path2: "festive",
  mainColor: "#112233",
  accentColor: "#ffffff",
  appId: "com.example.app",
  tag: "https://vast.example.com/tag.xml",
  feedLabel: "IN",
  utmSource: "newsletter",
  utmMedium: "email",
  brand: "Ashniva",
  brandName: "Ashniva",
  businessName: "Ashniva",
};

const isBlankText = (v: unknown) => typeof v !== "string" || v.trim() === "";

function textSample(field: Field & { maxLength?: number; minLength?: number }, samples: Samples) {
  let s = samples.text?.[field.key] ?? GLOBAL_TEXT[field.key] ?? `Sample ${field.label}`.replace(/\s+/g, " ");
  if (field.maxLength && s.length > field.maxLength) s = s.slice(0, field.maxLength).trim();
  if (field.minLength && s.length < field.minLength) s = s.padEnd(field.minLength, "x");
  return s;
}

function urlSample(field: Field & { maxLength?: number }, samples: Samples) {
  if (samples.text?.[field.key]) return samples.text[field.key]!;
  if (/youtube/i.test(field.key)) return "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  if (/deeplink/i.test(field.key)) return "https://example.com/app/home";
  return `https://www.example.com/${field.key.toLowerCase()}`;
}

const DAY = "2026-12-01";
const dateFor = (key: string) => (/end/i.test(key) ? "2026-12-31" : DAY);

function isBlank(field: Field, v: unknown): boolean {
  switch (field.type) {
    case "text":
    case "textarea":
    case "url":
      return isBlankText(v);
    case "textList":
      return !Array.isArray(v) || v.every((x) => (typeof x === "string" ? x : String((x as { text?: unknown })?.text ?? "")).trim() === "");
    case "number":
    case "money":
    case "percent":
      return v == null || v === "" || Number.isNaN(Number(v));
    case "repeater":
      return !Array.isArray(v) || v.length === 0 || v.every((it) => field.fields.every((f) => f.type === "info" || isBlank(f, (it as Values)?.[f.key])));
    case "date":
    case "datetime":
    case "accountOption":
      return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    case "multiSelect":
    case "chips":
    case "checkboxes":
    case "targeting":
    case "keywords":
    case "media":
      return !Array.isArray(v) || v.length === 0;
    default:
      return v === undefined;
  }
}

/** Media registry: fake creatives with the ratio/type the field asks for. */
export class MediaBag {
  readonly assets = new Map<string, BuilderAsset>();
  readonly info = new Map<string, MediaInfo>();
  private n = 0;
  /** A copy that keeps the base draft's media and numbers new files after them. */
  fork() {
    const m = new MediaBag();
    for (const [id, a] of this.assets) m.assets.set(id, a);
    for (const [id, i] of this.info) m.info.set(id, i);
    m.n = this.n;
    return m;
  }
  add(type: "IMAGE" | "VIDEO", ratio: string) {
    const [a, b] = ratio.split(":").map(Number);
    const width = 1200;
    const height = a && b ? Math.round((width * b) / a) : 1200;
    const id = `cr-${++this.n}`;
    const filename = type === "VIDEO" ? `clip-${this.n}.mp4` : `image-${this.n}.jpg`;
    this.assets.set(id, {
      creativeId: id,
      type,
      filename,
      mimeType: type === "VIDEO" ? "video/mp4" : "image/jpeg",
      width,
      height,
      load: async () => Buffer.from(`bytes-of-${id}`),
    });
    this.info.set(id, { type, width, height });
    return id;
  }
}

function sampleFor(field: Field, ctx: FieldContext, current: unknown, media: MediaBag, samples: Samples): unknown {
  switch (field.type) {
    case "text":
    case "textarea":
      return textSample(field, samples);
    case "url":
      return urlSample(field, samples);
    case "textList": {
      const n = Math.max(field.min, 1);
      return Array.from({ length: n }, (_, i) => {
        const text = /youtube/i.test(field.key) ? `https://www.youtube.com/watch?v=dQw4w9WgX${String.fromCharCode(97 + i)}` : `${i + 1} ${field.itemLabel}`.slice(0, field.maxLength).trim();
        return field.pinnable ? { text, pin: null } : text;
      });
    }
    case "number":
    case "money":
    case "percent": {
      if (field.default != null) return field.default;
      let n = 25;
      if (field.min != null && n < field.min) n = field.min;
      if (field.max != null && n > field.max) n = field.max;
      return n;
    }
    case "multiSelect":
    case "chips":
    case "checkboxes": {
      const options = resolveOptions(field, ctx);
      return options.slice(0, Math.max(field.min ?? 1, 1)).map((o) => o.value);
    }
    case "date":
      return dateFor(field.key);
    case "datetime":
      return `${dateFor(field.key)}T09:00`;
    case "accountOption": {
      const id = samples.accountOption?.[field.key] ?? samples.accountOption?.[field.source] ?? `${field.source}-1`;
      return field.multiple ? [id] : id;
    }
    case "targeting":
      if (field.kind === "location") return [{ id: "IN", name: "India", type: "country" }];
      if (field.kind === "language") return [{ id: "en", name: "English" }];
      return [{ id: `${field.kind}-1`, name: `Sample ${field.kind}` }];
    case "keywords":
      return Array.from({ length: Math.max(field.min ?? 1, 1) }, (_, i) => ({ text: `festive keyword ${i + 1}`, matchType: field.matchTypes[0]! }));
    case "media": {
      const type = field.accept.includes("IMAGE") ? "IMAGE" : "VIDEO";
      const ratio = field.requiredRatio ?? field.ratios?.[0] ?? "1:1";
      return Array.from({ length: Math.min(Math.max(field.min, 1), field.max) }, () => media.add(type, ratio));
    }
    case "repeater": {
      const items = Array.isArray(current) && current.length ? (current as Values[]).map((it) => ({ ...it })) : [];
      while (items.length < Math.max(field.min, 1)) items.push({});
      for (const item of items) fillFields(field.fields, item, () => ctx, media, samples);
      return items;
    }
    default:
      return current;
  }
}

/** A choice or multi-choice field (checked by `type` before the cast). */
type ChoiceLike = Extract<Field, { options: unknown }>;

const CHOICE = new Set(["select", "radio", "cards", "segmented"]);
const MULTI = new Set(["multiSelect", "chips", "checkboxes"]);

/** Fills blank visible fields; returns true when anything changed. */
function fillFields(fields: Field[], values: Values, ctx: () => FieldContext, media: MediaBag, samples: Samples, sectionVisible = true): boolean {
  let changed = false;
  if (!sectionVisible) return false;
  for (const f of fields) {
    if (f.type === "info" || !isVisible(f, ctx())) continue;
    const v = values[f.key];
    if (CHOICE.has(f.type)) {
      const allowed = resolveOptions(f as ChoiceLike, ctx()).map((o) => o.value);
      if (allowed.length && !allowed.includes(String(v ?? ""))) {
        values[f.key] = allowed[0];
        changed = true;
      }
      continue;
    }
    if (MULTI.has(f.type) && Array.isArray(v) && v.length) {
      const allowed = new Set(resolveOptions(f as ChoiceLike, ctx()).map((o) => o.value));
      const kept = (v as string[]).filter((x) => allowed.has(x));
      if (kept.length !== v.length) {
        values[f.key] = kept;
        changed = true;
      }
      if (kept.length) continue;
    }
    if (f.type === "repeater" && !isBlank(f, v)) {
      // Fill each existing item's own blank fields.
      for (const item of v as Values[]) if (fillFields(f.fields, item, ctx, media, samples)) changed = true;
      continue;
    }
    if (isBlank(f, values[f.key])) {
      const next = sampleFor(f, ctx(), values[f.key], media, samples);
      if (next !== undefined && !(Array.isArray(next) && next.length === 0)) {
        values[f.key] = next;
        changed = true;
      }
    }
  }
  return changed;
}

function fillLevel(level: LevelSpec | null, values: Values, ctx: () => FieldContext, media: MediaBag, samples: Samples) {
  if (!level) return false;
  let changed = false;
  for (const s of level.sections) if (fillFields(s.fields, values, ctx, media, samples, isVisible(s, ctx()))) changed = true;
  return changed;
}

/** Fills every visible field of the whole draft until nothing new appears. */
export function fillDraft(spec: PlatformBuilderSpec, draft: BuilderDraft, media: MediaBag, samples: Samples) {
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    const base = (): FieldContext => ({ setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} });
    if (fillLevel(spec.campaign, draft.campaign, base, media, samples)) changed = true;
    const adSpec = spec.ad(draft.setup);
    for (const g of draft.adGroups) {
      const gctx = (): FieldContext => ({ ...base(), adGroup: g.values });
      if (fillLevel(spec.adGroup, g.values, gctx, media, samples)) changed = true;
      for (const a of g.ads) if (fillLevel(adSpec, a.values, () => ({ ...gctx(), ad: a.values }), media, samples)) changed = true;
    }
    if (!changed) return;
  }
}

export function buildDraft(spec: PlatformBuilderSpec, setup: Values, samples: Samples, tweak?: (d: BuilderDraft) => void) {
  const media = new MediaBag();
  const draft = newDraft(spec, "acct-contract", setup, "Contract test campaign");
  fillDraft(spec, draft, media, samples);
  if (tweak) {
    tweak(draft);
    fillDraft(spec, draft, media, samples);
  }
  return { draft, media };
}

// ───────── Variants (form choices that change which fields show) ─────────

type LevelName = "campaign" | "adGroup" | "ad";

/** "level:key:required" for every visible field, so a choice that changes the form is detected. */
export function formShape(spec: PlatformBuilderSpec, draft: BuilderDraft) {
  const out: string[] = [];
  const walk = (level: LevelSpec | null, name: LevelName, ctx: FieldContext) => {
    if (!level) return;
    for (const s of level.sections) {
      if (!isVisible(s, ctx)) continue;
      for (const f of s.fields) if (f.type !== "info" && isVisible(f, ctx)) out.push(`${name}:${f.key}:${isRequired(f, ctx) ? 1 : 0}`);
    }
  };
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  walk(spec.campaign, "campaign", base);
  const g = draft.adGroups[0];
  if (g) {
    walk(spec.adGroup, "adGroup", { ...base, adGroup: g.values });
    const a = g.ads[0];
    if (a) walk(spec.ad(draft.setup), "ad", { ...base, adGroup: g.values, ad: a.values });
  }
  return out.sort().join("|");
}

const clone = <T>(v: T): T => structuredClone(v);

export interface Variant {
  name: string;
  draft: BuilderDraft;
  media: MediaBag;
}

/**
 * One draft per alternative of each in-form choice (format, budget type, bid
 * strategy, conversion location, toggles…) that changes the visible form.
 */
export function variants(spec: PlatformBuilderSpec, setup: Values, samples: Samples, tweak: ((d: BuilderDraft) => void) | undefined, cap = 12): Variant[] {
  const { draft: base, media: baseMedia } = buildDraft(spec, setup, samples, tweak);
  const shape = formShape(spec, base);
  const out: Variant[] = [{ name: "base", draft: base, media: baseMedia }];
  const levels: [LevelName, LevelSpec | null, (d: BuilderDraft) => Values | undefined][] = [
    ["campaign", spec.campaign, (d) => d.campaign],
    ["adGroup", spec.adGroup, (d) => d.adGroups[0]?.values],
    ["ad", spec.ad(setup), (d) => d.adGroups[0]?.ads[0]?.values],
  ];
  for (const [name, level, pick] of levels) {
    if (!level) continue;
    for (const f of levelFields(level)) {
      if (f.key === "launchStatus") continue;
      const values = pick(base);
      if (!values) continue;
      const ctx: FieldContext = { setup, campaign: base.campaign, adGroup: base.adGroups[0]?.values ?? {}, ad: base.adGroups[0]?.ads[0]?.values ?? {} };
      if (!isVisible(f, ctx)) continue;
      let alternatives: unknown[] = [];
      if (CHOICE.has(f.type)) alternatives = resolveOptions(f as ChoiceLike, ctx).map((o) => o.value).filter((v) => v !== values[f.key]);
      else if (f.type === "toggle") alternatives = [!values[f.key]];
      for (const alt of alternatives) {
        if (out.length > cap) return out;
        const media = baseMedia.fork();
        const d = clone(base);
        pick(d)![f.key] = alt;
        fillDraft(spec, d, media, samples);
        if (formShape(spec, d) === shape) continue;
        out.push({ name: `${name}.${f.key}=${String(alt)}`, draft: d, media });
      }
    }
  }
  return out;
}

// ───────── Key tracking ─────────

export type Reads = Set<string>;

function tracked(obj: Values, level: string, reads: Reads, repeaters: Map<string, Set<string>>): Values {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || prop === "toJSON") return value;
      reads.add(`${level}:${prop}`);
      if (repeaters.has(`${level}:${prop}`) && Array.isArray(value)) {
        return value.map((item) => (item && typeof item === "object" ? tracked(item as Values, `${level}.${prop}[]`, reads, repeaters) : item));
      }
      return value;
    },
    has(target, prop) {
      if (typeof prop === "string") reads.add(`${level}:${prop}`);
      return Reflect.has(target, prop);
    },
  });
}

/** Spec field keys per level (any visibility), plus repeater sub-levels and setup keys. */
export function specKeys(spec: PlatformBuilderSpec, setup: Values) {
  const keys = new Map<string, Set<string>>();
  const repeaters = new Map<string, Set<string>>();
  const add = (level: string, fields: Field[]) => {
    const set = keys.get(level) ?? new Set<string>();
    keys.set(level, set);
    for (const f of fields) {
      if (f.type === "info") continue;
      set.add(f.key);
      if (f.type === "repeater") {
        const sub = new Set(f.fields.map((x) => x.key));
        repeaters.set(`${level}:${f.key}`, sub);
        add(`${level}.${f.key}[]`, f.fields);
      }
    }
  };
  keys.set("setup", new Set(spec.setup.map((s) => s.key)));
  add("campaign", levelFields(spec.campaign));
  add("adGroup", levelFields(spec.adGroup));
  const adSpec = spec.ad(setup);
  add("ad", adSpec ? levelFields(adSpec) : []);
  return { keys, repeaters };
}

/** The draft the connector gets, with every values object recording what is read. */
export function trackDraft(spec: PlatformBuilderSpec, draft: BuilderDraft, reads: Reads): BuilderDraft {
  const { repeaters } = specKeys(spec, draft.setup);
  const vd = visibleDraft(spec, draft);
  return {
    ...vd,
    setup: tracked(vd.setup, "setup", reads, repeaters),
    campaign: tracked(vd.campaign, "campaign", reads, repeaters),
    adGroups: vd.adGroups.map((g) => ({
      ...g,
      values: tracked(g.values, "adGroup", reads, repeaters),
      ads: g.ads.map((a) => ({ ...a, values: tracked(a.values, "ad", reads, repeaters) })),
    })),
  };
}

/** Required, visible fields of the draft as "level:key" (repeater items as "ad.cards[]:key"). */
export function requiredVisible(spec: PlatformBuilderSpec, draft: BuilderDraft): Set<string> {
  const out = new Set<string>();
  const walkFields = (fields: Field[], values: Values, level: string, ctx: FieldContext) => {
    for (const f of fields) {
      if (f.type === "info" || !isVisible(f, ctx)) continue;
      if (isRequired(f, ctx)) out.add(`${level}:${f.key}`);
      if (f.type === "repeater") for (const item of (values[f.key] as Values[] | undefined) ?? []) walkFields(f.fields, item, `${level}.${f.key}[]`, ctx);
    }
  };
  const walk = (level: LevelSpec | null, name: string, values: Values, ctx: FieldContext) => {
    if (!level) return;
    for (const s of level.sections) if (isVisible(s, ctx)) walkFields(s.fields, values, name, ctx);
  };
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  walk(spec.campaign, "campaign", draft.campaign, base);
  const adSpec = spec.ad(draft.setup);
  for (const g of draft.adGroups) {
    const gctx = { ...base, adGroup: g.values };
    walk(spec.adGroup, "adGroup", g.values, gctx);
    for (const a of g.ads) walk(adSpec, "ad", a.values, { ...gctx, ad: a.values });
  }
  return out;
}

// ───────── One run ─────────

export interface RunResult {
  name: string;
  setup: Values;
  draft: BuilderDraft;
  issues: BuilderIssue[];
  reads: Reads;
  required: Set<string>;
  keys: Map<string, Set<string>>;
  calls: Recorded[];
  structure?: AccountStructure;
  error?: unknown;
}

export interface RunInput {
  spec: PlatformBuilderSpec;
  connector: AdPlatformConnector;
  auth: ConnectorAuth;
  account: AccountRef & { currency: string; timezone?: string | null };
  respond: () => Responder;
}

/** Runs share the global fetch spy, so they go one at a time. */
let queue: Promise<unknown> = Promise.resolve();

export function runCreate(input: RunInput, v: Variant): Promise<RunResult> {
  const next = queue.then(() => runCreateNow(input, v));
  queue = next.catch(() => undefined);
  return next;
}

async function runCreateNow(input: RunInput, v: Variant): Promise<RunResult> {
  const { spec, connector } = input;
  const issues = validateDraft(spec, v.draft, v.media.info);
  const reads: Reads = new Set();
  const { keys } = specKeys(spec, v.draft.setup);
  const required = requiredVisible(spec, v.draft);
  const rec = recordFetch(input.respond());
  const result: RunResult = { name: v.name, setup: v.draft.setup, draft: v.draft, issues, reads, required, keys, calls: rec.calls };
  try {
    result.structure = await connector.createCampaign!(input.auth, input.account, trackDraft(spec, v.draft, reads), v.media.assets);
  } catch (err) {
    result.error = err;
  } finally {
    rec.restore();
  }
  return result;
}

/**
 * Reads that are not a contract mismatch even though no field defines them:
 *  - `name` on ad groups and ads: newAdGroup/newAd always write it ("Ad set 1"), with or without a name field.
 *  - `budgetType`: budgetOf() probes `<key>Type` to tell daily from lifetime; on forms built with
 *    budgetFields({ lifetime: false }) it is always absent, so the budget is daily, as the form says.
 */
export const ENGINE_KEYS = new Set(["adGroup:name", "ad:name"]);
export const HELPER_PROBES = new Set(["campaign:budgetType", "adGroup:budgetType"]);

const splitKey = (k: string) => {
  const i = k.lastIndexOf(":");
  return [k.slice(0, i), k.slice(i + 1)] as const;
};

/** Spec keys per level across every setup of the platform. */
export function unionKeys(spec: PlatformBuilderSpec, setups: Values[]) {
  const out = new Map<string, Set<string>>();
  for (const s of setups) {
    for (const [level, keys] of specKeys(spec, s).keys) {
      const set = out.get(level) ?? new Set<string>();
      keys.forEach((k) => set.add(k));
      out.set(level, set);
    }
  }
  return out;
}

/**
 * Keys the connector read that the form never defines at that level, for any setup of the
 * platform. Keys only defined for another setup (type-agnostic code that reads e.g. every
 * image key on every ad) are left to `crossSetupReads`: the value is absent, so nothing is sent.
 */
export function extraReads(r: RunResult, union?: Map<string, Set<string>>) {
  return [...r.reads].filter((k) => {
    if (ENGINE_KEYS.has(k) || HELPER_PROBES.has(k)) return false;
    const [level, key] = splitKey(k);
    if (r.keys.get(level)?.has(key)) return false;
    return !(union?.get(level)?.has(key) ?? false);
  });
}

/** Reads of keys that only another setup's form defines (informational). */
export function crossSetupReads(r: RunResult, union: Map<string, Set<string>>) {
  return [...r.reads].filter((k) => {
    if (ENGINE_KEYS.has(k) || HELPER_PROBES.has(k)) return false;
    const [level, key] = splitKey(k);
    return !r.keys.get(level)?.has(key) && (union.get(level)?.has(key) ?? false);
  });
}

/** Visible fields the user can fill that the connector never reads, required or not (informational). */
export function unreadVisible(spec: PlatformBuilderSpec, r: RunResult) {
  const out = new Set<string>();
  const walk = (fields: Field[], level: string, ctx: FieldContext) => {
    for (const f of fields) {
      if (f.type === "info" || !isVisible(f, ctx)) continue;
      if (!r.reads.has(`${level}:${f.key}`)) out.add(`${level}:${f.key}`);
      else if (f.type === "repeater") walk(f.fields, `${level}.${f.key}[]`, ctx);
    }
  };
  const lv = (level: LevelSpec | null, name: string, ctx: FieldContext) => {
    if (level) for (const s of level.sections) if (isVisible(s, ctx)) walk(s.fields, name, ctx);
  };
  const d = r.draft;
  const base: FieldContext = { setup: d.setup, campaign: d.campaign, adGroup: {}, ad: {} };
  lv(spec.campaign, "campaign", base);
  const g = d.adGroups[0];
  if (g) {
    lv(spec.adGroup, "adGroup", { ...base, adGroup: g.values });
    if (g.ads[0]) lv(spec.ad(d.setup), "ad", { ...base, adGroup: g.values, ad: g.ads[0].values });
  }
  return [...out];
}

/** Required, visible form fields the connector never read. */
export function unreadRequired(r: RunResult) {
  return [...r.required].filter((k) => !r.reads.has(k));
}

// ───────── Status & snapshot helpers ─────────

const STATUS_KEY = /^(status|state|entity_status|intendedStatus|is_active|enabled|isenabled|configured_status|operation_status)$/i;
export const ACTIVE_VALUES = new Set(["ACTIVE", "ENABLED", "Active", "enabled", "ENABLE", "true", "RUNNING"]);
export const PAUSED_VALUES = new Set(["PAUSED", "Paused", "paused", "false", "DISABLE", "DISABLED"]);

export interface StatusHit {
  where: string;
  value: string;
}

/** Every status-like value sent, as "METHOD /path body.path=value" hits. */
export function statusHits(calls: Recorded[]): StatusHit[] {
  const hits: StatusHit[] = [];
  const walk = (v: unknown, path: string, where: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, where));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (STATUS_KEY.test(k) && (typeof x === "string" || typeof x === "boolean")) hits.push({ where: `${where} ${path}.${k}`, value: String(x) });
        walk(x, `${path}.${k}`, where);
      }
    }
  };
  for (const c of calls) {
    const where = `${c.method} ${c.url.pathname}`;
    walk(c.body, "body", where);
    for (const [k, v] of c.url.searchParams) if (STATUS_KEY.test(k)) hits.push({ where: `${where} query.${k}`, value: v });
  }
  return hits;
}

const BASE64 = /^[A-Za-z0-9+/]{40,}={0,2}$/;

/** Request list with node keys, tokens and file bytes replaced by stable placeholders. */
export function snapshotCalls(calls: Recorded[], draft: BuilderDraft, skip: (c: Recorded) => boolean = () => false) {
  const names = new Map<string, string>();
  draft.adGroups.forEach((g, i) => {
    names.set(g.key, `<adGroup${i + 1}>`);
    g.ads.forEach((a, j) => names.set(a.key, `<ad${i + 1}.${j + 1}>`));
  });
  const fix = (s: string) => {
    let out = s;
    for (const [k, v] of names) out = out.split(k).join(v);
    if (BASE64.test(out)) return "<base64>";
    return out;
  };
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "access_token").map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return calls
    .filter((c) => !skip(c))
    .map((c) => {
      const query = [...c.url.searchParams].filter(([k]) => k !== "access_token" && !k.startsWith("oauth_")).sort(([a], [b]) => a.localeCompare(b));
      return {
        request: `${c.method} ${c.url.host}${fix(decodeURIComponent(c.url.pathname))}`,
        ...(query.length ? { query: Object.fromEntries(query.map(([k, v]) => [k, fix(v)])) } : {}),
        ...(c.body !== undefined ? { body: norm(c.body) } : {}),
      };
    });
}

/** Paths that would publish an organic (non-ad) post. */
export const ORGANIC_ENDPOINTS: RegExp[] = [
  /^\/2\/tweets\b/, // X: public post
  /^\/1\.1\/statuses\//, // X v1.1 status update
  /^\/v\d+(\.\d+)?\/\d+\/(feed|photos)$/, // Meta Page feed / photo posts
  /^\/rest\/posts\b/, // LinkedIn organic posts
  /^\/v2\/(ugcPosts|shares)\b/, // LinkedIn legacy organic posts
];
