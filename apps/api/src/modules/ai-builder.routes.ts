/**
 * AI endpoints for the campaign builder and automations. Mounted inside
 * aiRouter, after the rate limiter and the active-plan check.
 */
import { inspectDraft } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import { PLATFORMS, PLATFORM_INFO, isBuilderDraft, type BuilderIssue } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { audienceIdeas, fillAd, keywordIdeas, reviewDraft, ruleFromText, suggestField } from "../lib/ai/builder";
import { badRequest, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";
import { callerOf } from "./ai.routes";

export const aiBuilderRouter = Router({ mergeParams: true });

const briefSchema = z.object({
  product: z.string().trim().min(3, "Describe what you're advertising").max(800),
  audience: z.string().trim().max(400).optional(),
  offer: z.string().trim().max(400).optional(),
  tone: z.string().trim().max(60).optional(),
  language: z.string().trim().max(40).optional(),
  url: z.string().trim().max(500).optional(),
});

const draftPayload = z.custom<unknown>((v) => isBuilderDraft(v), "This doesn't look like a campaign draft.");

aiBuilderRouter.post("/ai/builder/fill", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(z.object({ draft: draftPayload, adGroupKey: z.string(), adKey: z.string().optional(), brief: briefSchema }), req.body);
  if (!isBuilderDraft(input.draft)) throw badRequest("Invalid draft.");
  res.json(await fillAd(callerOf(req), input.draft, { adGroupKey: input.adGroupKey, adKey: input.adKey }, input.brief));
});

aiBuilderRouter.post("/ai/builder/suggest", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(
    z.object({
      platform: z.enum(PLATFORMS),
      label: z.string().max(100),
      purpose: z.string().max(300),
      maxLength: z.number().int().min(5).max(3000),
      count: z.number().int().min(1).max(10).default(5),
      current: z.array(z.string().max(3000)).max(20).default([]),
      context: z.string().max(4000).default(""),
      brief: briefSchema.partial().optional(),
    }),
    req.body,
  );
  const brief = input.brief?.product ? (input.brief as z.infer<typeof briefSchema>) : undefined;
  res.json({ suggestions: await suggestField(callerOf(req), { ...input, brief }) });
});

aiBuilderRouter.post("/ai/builder/keywords", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(
    z.object({ platform: z.enum(PLATFORMS), brief: briefSchema, existing: z.array(z.string().max(100)).max(1000).default([]), negative: z.boolean().default(false) }),
    req.body,
  );
  res.json({ keywords: await keywordIdeas(callerOf(req), { ...input, platform: PLATFORM_INFO[input.platform].name }) });
});

aiBuilderRouter.post("/ai/builder/audience", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(
    z.object({
      platform: z.enum(PLATFORMS),
      kind: z.string().max(40).default("interests"),
      brief: briefSchema,
      ageMin: z.number().int().min(13).max(65).default(18),
      ageMax: z.number().int().min(13).max(65).default(65),
    }),
    req.body,
  );
  res.json(await audienceIdeas(callerOf(req), { platform: PLATFORM_INFO[input.platform].name, kind: input.kind, brief: input.brief, ageBounds: { min: input.ageMin, max: input.ageMax } }));
});

aiBuilderRouter.post("/ai/builder/review", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(z.object({ draft: draftPayload }), req.body);
  if (!isBuilderDraft(input.draft)) throw badRequest("Invalid draft.");
  let issues: BuilderIssue[] = [];
  let currency = req.workspace!.currency;
  try {
    const inspected = await inspectDraft(req.workspace!.id, input.draft);
    issues = inspected.issues;
    currency = inspected.account?.currency ?? currency;
  } catch (err) {
    issues = (err as { issues?: BuilderIssue[] }).issues ?? [];
  }
  res.json(await reviewDraft(callerOf(req), input.draft, issues, currency));
});

aiBuilderRouter.post("/ai/rules/from-text", requirePermission("campaigns:edit"), async (req, res) => {
  const { text } = parse(z.object({ text: z.string().trim().min(10, "Describe the rule in a sentence").max(600) }), req.body);
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: req.workspace!.id }, select: { currency: true } });
  res.json(await ruleFromText(callerOf(req), text, ws.currency));
});
