/**
 * AI help inside the campaign builder and automations: fill an ad from a
 * brief, per-field suggestions, keyword and audience ideas, a pre-launch
 * review, and rules written from a sentence. Every limit comes from the
 * platform spec, and output is clipped to it.
 */
import {
  BUILDER_SPECS,
  PLATFORM_INFO,
  RULE_ACTIONS,
  RULE_METRICS,
  RULE_OPERATORS,
  isVisible,
  levelFields,
  resolveOptions,
  setupOptions,
  type AiAudienceResponse,
  type AiFillResponse,
  type AiKeywordIdea,
  type AiReviewResponse,
  type BuilderDraft,
  type BuilderIssue,
  type ChoiceField,
  type Field,
  type FieldContext,
  type LevelSpec,
  type RuleInput,
  type TextField,
  type TextListField,
  type Values,
} from "@ashniva/shared";
import { z } from "zod";
import { COPYWRITER_SYSTEM, runAi, type AiCaller } from "./index";

export interface Brief {
  product: string;
  audience?: string;
  offer?: string;
  tone?: string;
  language?: string;
  url?: string;
}

const briefLines = (b: Brief) =>
  [
    `Product or service: ${b.product}`,
    b.audience && `Target audience: ${b.audience}`,
    b.offer && `Offer or key message: ${b.offer}`,
    b.tone && `Tone: ${b.tone}`,
    b.url && `Landing page: ${b.url}`,
    `Language: ${b.language || "English"}`,
  ].filter(Boolean) as string[];

/** "Meta Ads · Sales · Website" style description of what's being built. */
function describeSetup(draft: BuilderDraft) {
  const spec = BUILDER_SPECS[draft.platform];
  const parts = [PLATFORM_INFO[draft.platform].name];
  for (const choice of spec.setup) {
    const value = draft.setup[choice.key];
    const opt = setupOptions(choice, draft.setup).find((o) => o.value === value);
    if (opt) parts.push(`${choice.label}: ${opt.label}`);
  }
  return parts.join(" · ");
}

/** Fields the AI can write at one level, given what's visible right now. */
function aiFields(level: LevelSpec, ctx: FieldContext) {
  const out: (TextField | TextListField)[] = [];
  for (const section of level.sections) {
    if (!isVisible(section, ctx)) continue;
    for (const f of section.fields) {
      if (!f.ai || !isVisible(f, ctx)) continue;
      if (f.type === "text" || f.type === "textarea" || f.type === "textList") out.push(f);
    }
  }
  return out;
}

/** How many items to ask for: platforms reward more variety, up to a sensible cap. */
const listTarget = (f: TextListField) => Math.max(f.min, Math.min(f.max, f.maxLength <= 30 ? 10 : 4));

/** Cuts text at a word boundary to fit a hard limit. */
function fit(text: string, max: number) {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "");
}

function fieldSchema(f: TextField | TextListField) {
  const limit = f.maxLength ?? 200;
  const hint = `${f.label}: ${f.ai?.purpose ?? f.label}. Each at most ${limit} characters${f.recommendedLength ? `, ideally under ${f.recommendedLength}` : ""}.`;
  if (f.type === "textList") return z.array(z.string()).describe(`${hint} Return ${listTarget(f)} distinct items.`);
  return z.string().describe(hint);
}

function clipValue(f: TextField | TextListField, value: unknown) {
  if (f.type === "textList") {
    // Slightly long items are shortened at a word boundary; much longer ones are dropped.
    const items = (Array.isArray(value) ? value : [])
      .map(String)
      .map((s) => s.trim())
      .filter((s) => s && s.length <= f.maxLength * 1.3)
      .map((s) => fit(s, f.maxLength))
      .filter((s) => s.length >= Math.min(8, f.maxLength / 2));
    const unique = [...new Map(items.map((s) => [s.toLowerCase(), s])).values()].slice(0, f.max);
    return f.pinnable ? unique.map((text) => ({ text, pin: null })) : unique;
  }
  return fit(String(value ?? ""), f.maxLength ?? 200);
}

// ───────── Fill a whole ad ─────────

export async function fillAd(caller: AiCaller, draft: BuilderDraft, nodes: { adGroupKey: string; adKey?: string }, brief: Brief): Promise<AiFillResponse> {
  const spec = BUILDER_SPECS[draft.platform];
  const group = draft.adGroups.find((g) => g.key === nodes.adGroupKey) ?? draft.adGroups[0];
  const ad = group?.ads.find((a) => a.key === nodes.adKey) ?? group?.ads[0];
  const ctx: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: group?.values ?? {}, ad: ad?.values ?? {} };
  const adSpec = spec.ad(draft.setup);

  const levels = {
    campaign: aiFields(spec.campaign, ctx),
    adGroup: aiFields(spec.adGroup, ctx).filter((f) => f.type !== "text" || f.key !== "name"),
    ad: adSpec ? aiFields(adSpec, ctx) : [],
  };
  const shape = (fields: (TextField | TextListField)[]) => z.object(Object.fromEntries(fields.map((f) => [f.key, fieldSchema(f)])));
  const schema = z.object({
    campaign: shape(levels.campaign),
    adGroup: shape(levels.adGroup),
    ad: shape(levels.ad),
    notes: z.array(z.string()).describe("1–3 short tips about this ad for the advertiser"),
  });

  const ctaField = adSpec ? levelFields(adSpec).find((f): f is ChoiceField => f.key === "cta" && f.type === "select") : undefined;
  const ctaOptions = ctaField && isVisible(ctaField, ctx) ? resolveOptions(ctaField, ctx).map((o) => o.value) : [];

  const result = await runAi(caller, "builder.fill", {
    schema: ctaOptions.length ? schema.extend({ cta: z.enum(ctaOptions as [string, ...string[]]).describe("Best call-to-action button") }) : schema,
    system: COPYWRITER_SYSTEM,
    prompt: [
      `Write the ad for: ${describeSetup(draft)}.`,
      `Campaign name: ${String(draft.campaign.name ?? "")}`,
      ...briefLines(brief),
      "",
      "Fill every field in the schema. Respect each field's character limit exactly.",
    ].join("\n"),
    maxTokens: 6000,
  });

  const out: AiFillResponse = { campaign: {}, adGroup: {}, ad: {}, notes: (result.notes ?? []).slice(0, 3) };
  for (const level of ["campaign", "adGroup", "ad"] as const) {
    const got = (result[level] ?? {}) as Values;
    for (const f of levels[level]) if (got[f.key] != null) out[level][f.key] = clipValue(f, got[f.key]);
  }
  const cta = (result as { cta?: string }).cta;
  if (cta && ctaOptions.includes(cta)) out.ad.cta = cta;
  return out;
}

// ───────── One field ─────────

export async function suggestField(
  caller: AiCaller,
  input: { platform: keyof typeof PLATFORM_INFO; label: string; purpose: string; maxLength: number; count: number; current: string[]; context: string; brief?: Brief },
) {
  const schema = z.object({ suggestions: z.array(z.string()).describe(`${input.count} distinct options, each at most ${input.maxLength} characters`) });
  const res = await runAi(caller, "builder.suggest", {
    schema,
    system: COPYWRITER_SYSTEM,
    prompt: [
      `Platform: ${PLATFORM_INFO[input.platform].name}`,
      `Field: ${input.label} (${input.purpose}). Hard limit: ${input.maxLength} characters.`,
      input.current.length ? `Already written (don't repeat): ${input.current.map((c) => `"${c}"`).join(", ")}` : "",
      input.context ? `Rest of the ad:\n${input.context}` : "",
      ...(input.brief ? briefLines(input.brief) : []),
      `Write ${input.count} new options.`,
    ]
      .filter(Boolean)
      .join("\n"),
    maxTokens: 2000,
  });
  const seen = new Set(input.current.map((c) => c.toLowerCase()));
  return res.suggestions
    .map((s) => s.trim())
    .filter((s) => s && s.length <= input.maxLength && !seen.has(s.toLowerCase()))
    .slice(0, input.count);
}

// ───────── Keywords & audiences ─────────

export async function keywordIdeas(caller: AiCaller, input: { platform: string; brief: Brief; existing: string[]; negative: boolean }): Promise<AiKeywordIdea[]> {
  const schema = z.object({
    keywords: z.array(
      z.object({
        text: z.string().describe("lowercase keyword, at most 80 characters, no match-type symbols"),
        matchType: z.enum(["BROAD", "PHRASE", "EXACT"]),
        intent: z.enum(["high", "medium", "low"]),
      }),
    ),
  });
  const res = await runAi(caller, "builder.keywords", {
    schema,
    system:
      "You are a paid-search strategist. Suggest search keywords grouped by purchase intent. Prefer specific multi-word keywords people actually type; include brand + product, problem + solution, and local modifiers when relevant. Use EXACT for the highest-intent terms, PHRASE for core terms, BROAD sparingly for discovery.",
    prompt: [
      `Platform: ${input.platform}`,
      ...briefLines(input.brief),
      input.existing.length ? `Already added: ${input.existing.join(", ")}` : "",
      input.negative
        ? "Suggest 15 NEGATIVE keywords: searches that waste money for this advertiser (jobs, free, DIY, competitors' support, wrong intent). Use PHRASE or EXACT."
        : "Suggest 20 keywords.",
    ]
      .filter(Boolean)
      .join("\n"),
    maxTokens: 2500,
  });
  const have = new Set(input.existing.map((k) => k.toLowerCase()));
  return res.keywords
    .map((k) => ({ ...k, text: k.text.toLowerCase().replace(/["[\]+]/g, "").trim() }))
    .filter((k) => k.text && k.text.length <= 80 && !have.has(k.text))
    .slice(0, 25);
}

export async function audienceIdeas(caller: AiCaller, input: { platform: string; kind: string; brief: Brief; ageBounds: { min: number; max: number } }): Promise<AiAudienceResponse> {
  const schema = z.object({
    interests: z.array(z.string()).describe(`8–15 targeting ${input.kind} names as they appear on the platform`),
    ageMin: z.number().int(),
    ageMax: z.number().int(),
    gender: z.enum(["ALL", "MALE", "FEMALE"]),
    rationale: z.string().describe("two sentences on why"),
  });
  const res = await runAi(caller, "builder.audience", {
    schema,
    system:
      "You are a paid-social targeting expert. Suggest audiences using the platform's own targeting vocabulary. Prefer broad, high-volume options; avoid sensitive categories (health, religion, ethnicity, sexuality, politics, financial status).",
    prompt: [`Platform: ${input.platform}`, `Targeting type: ${input.kind}`, ...briefLines(input.brief), `Age must stay within ${input.ageBounds.min}–${input.ageBounds.max}.`].join("\n"),
    maxTokens: 1500,
  });
  const clamp = (n: number) => Math.min(input.ageBounds.max, Math.max(input.ageBounds.min, Math.round(n)));
  const ageMin = clamp(res.ageMin);
  return { ...res, interests: [...new Set(res.interests.map((s) => s.trim()).filter(Boolean))].slice(0, 15), ageMin, ageMax: Math.max(ageMin, clamp(res.ageMax)) };
}

// ───────── Pre-launch review ─────────

/** Readable dump of a draft: labels and values of every visible field. */
function draftSummary(draft: BuilderDraft) {
  const spec = BUILDER_SPECS[draft.platform];
  const lines: string[] = [describeSetup(draft)];
  const dump = (level: LevelSpec, values: Values, ctx: FieldContext, indent: string) => {
    for (const section of level.sections) {
      if (!isVisible(section, ctx)) continue;
      for (const f of section.fields as Field[]) {
        if (f.type === "info" || f.type === "media" || !isVisible(f, ctx)) continue;
        const v = values[f.key];
        if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
        lines.push(`${indent}${f.label}: ${typeof v === "string" ? v : JSON.stringify(v).slice(0, 600)}`);
      }
    }
  };
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  lines.push(`${spec.campaign.label}:`);
  dump(spec.campaign, draft.campaign, base, "  ");
  const adSpec = spec.ad(draft.setup);
  draft.adGroups.forEach((g, i) => {
    lines.push(`${spec.adGroup.label} ${i + 1}:`);
    dump(spec.adGroup, g.values, { ...base, adGroup: g.values }, "  ");
    if (adSpec)
      g.ads.forEach((a, j) => {
        lines.push(`  ${adSpec.label} ${j + 1}:`);
        dump(adSpec, a.values, { ...base, adGroup: g.values, ad: a.values }, "    ");
      });
  });
  return lines.join("\n");
}

export async function reviewDraft(caller: AiCaller, draft: BuilderDraft, issues: BuilderIssue[], currency: string): Promise<AiReviewResponse> {
  const schema = z.object({
    score: z.number().int().describe("0–100 readiness and quality score"),
    summary: z.string().describe("two sentences"),
    strengths: z.array(z.string()).describe("up to 3"),
    issues: z.array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        area: z.string().describe("e.g. Policy, Copy, Targeting, Budget, Tracking, Creative"),
        message: z.string(),
        fix: z.string().describe("a concrete change to make"),
      }),
    ),
  });
  const res = await runAi(caller, "builder.review", {
    schema,
    system:
      "You review ad campaigns before launch like a senior media buyer and an ad-policy specialist. Check: policy risks (prohibited claims, personal attributes, misleading urgency, restricted categories), copy quality and variety, mismatch between objective, optimization and tracking, audience size and targeting conflicts, budget sanity for the goal (e.g. budget vs bid, learning phase needs about 50 conversions a week), and missing best practices. Be specific; quote the text you refer to. Up to 8 issues, most important first.",
    prompt: [
      `Currency: ${currency}`,
      draftSummary(draft),
      issues.length ? `\nThe builder already found these blocking problems:\n${issues.map((i) => `- ${i.message}`).join("\n")}` : "\nThe builder found no blocking problems.",
    ].join("\n"),
    maxTokens: 4000,
  });
  return { ...res, score: Math.max(0, Math.min(100, Math.round(res.score))), strengths: res.strengths.slice(0, 3), issues: res.issues.slice(0, 8) };
}

// ───────── Rules from a sentence ─────────

export async function ruleFromText(caller: AiCaller, text: string, currency: string): Promise<RuleInput> {
  const schema = z.object({
    name: z.string(),
    conditionLogic: z.enum(["ALL", "ANY"]),
    conditions: z.array(z.object({ metric: z.enum(RULE_METRICS), operator: z.enum(RULE_OPERATORS), value: z.number() })),
    actions: z.array(
      z.object({
        type: z.enum(RULE_ACTIONS),
        percent: z.number().describe("1–100 for budget changes, otherwise 0"),
        maxBudget: z.number().describe("budget ceiling for increases, 0 for none"),
        email: z.boolean(),
      }),
    ),
    lookbackDays: z.number().int(),
    frequency: z.enum(["HOURLY", "DAILY"]),
    minSpend: z.number().describe("only evaluate campaigns that spent at least this much in the lookback, 0 for any"),
  });
  const res = await runAi(caller, "rules.fromText", {
    schema,
    system: `You turn a marketer's description into an automation rule for ad campaigns. Metrics: spend, impressions, clicks, ctr (as a fraction: 1% = 0.01), cpc, cpm, conversions, cpa, roas (as a multiple: 2× = 2). Money is in ${currency}. Pick a sensible lookback (default 3 days) and name the rule in a few words.`,
    prompt: text,
    maxTokens: 1500,
  });
  return {
    name: res.name.slice(0, 120),
    isActive: true,
    scope: { platforms: [], campaignIds: [], minSpend: Math.max(0, res.minSpend) },
    conditionLogic: res.conditionLogic,
    conditions: res.conditions.slice(0, 5).map((c) => ({ ...c, value: Math.max(0, c.value) })),
    actions: res.actions.slice(0, 3).map((a) => ({
      type: a.type,
      ...(a.type === "INCREASE_BUDGET" || a.type === "DECREASE_BUDGET" ? { percent: Math.min(100, Math.max(1, Math.round(a.percent || 10))) } : {}),
      ...(a.type === "INCREASE_BUDGET" && a.maxBudget > 0 ? { maxBudget: a.maxBudget } : {}),
      ...(a.type === "NOTIFY" ? { email: a.email } : {}),
    })),
    lookbackDays: Math.min(30, Math.max(1, res.lookbackDays)),
    frequency: res.frequency,
    cooldownHours: 24,
  };
}
